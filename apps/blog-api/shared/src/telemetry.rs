//! OpenTelemetry SDK の初期化とライフサイクル管理。
//!
//! Lambda -> tidb-proxy (ECS) 上の ADOT Collector sidecar へ OTLP/HTTP で
//! traces / metrics を送る。Collector 側で traces は X-Ray へ、metrics は
//! CloudWatch OTel Metrics (OTLP ネイティブ) へ export する。
//!
//! - `OTEL_EXPORTER_OTLP_ENDPOINT` 未設定時は完全に無効化 (ローカル開発を壊さない)
//! - trace ID は awsxray exporter が受理できるよう X-Ray 互換 ID generator を使う
//! - metrics は PromQL の `rate()` / `histogram_quantile()` 前提の cumulative
//!   temporality (SDK デフォルト) で送る
//! - Lambda は同一ラベルのサンドボックスが並行に存在し得るため、
//!   `service.instance.id` でプロセスごとに系列を分離する (これが無いと複数
//!   プロセスの cumulative 値が混ざって rate() が壊れる)
//! - Lambda は invoke 間で freeze されるため、batch processor / periodic reader の
//!   バックグラウンド export だけに頼らず、リクエスト処理後に `flush()` を呼んで
//!   ベストエフォートで送り切る

use std::sync::OnceLock;
use std::time::Duration;

use opentelemetry::{KeyValue, global};
use opentelemetry_aws::trace::XrayIdGenerator;
use opentelemetry_otlp::{Protocol, WithExportConfig};
use opentelemetry_sdk::Resource;
use opentelemetry_sdk::metrics::{PeriodicReader, SdkMeterProvider};
use opentelemetry_sdk::trace::{SdkTracer, SdkTracerProvider};

static PROVIDERS: OnceLock<(SdkTracerProvider, SdkMeterProvider)> = OnceLock::new();

/// tracing-opentelemetry layer に渡す tracer を保持する初期化結果。
pub struct Telemetry {
    pub tracer: SdkTracer,
}

/// OTel SDK を初期化する。`OTEL_EXPORTER_OTLP_ENDPOINT` 未設定なら `None`。
///
/// OTLP/HTTP exporter (reqwest blocking client) の生成は async runtime 上で行うと
/// panic する既知の問題があるため、tokio runtime 起動 **前** に呼ぶこと。
pub fn init_telemetry() -> Option<Telemetry> {
    let endpoint = std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT")
        .ok()
        .filter(|v| !v.trim().is_empty())?;
    let base = endpoint.trim_end_matches('/').to_string();

    let service_name =
        std::env::var("OTEL_SERVICE_NAME").unwrap_or_else(|_| "blog-api".to_string());
    let resource = Resource::builder()
        .with_service_name(service_name)
        .with_attribute(KeyValue::new(
            "service.instance.id",
            uuid::Uuid::new_v4().to_string(),
        ))
        .build();

    let span_exporter = match opentelemetry_otlp::SpanExporter::builder()
        .with_http()
        .with_protocol(Protocol::HttpBinary)
        .with_endpoint(format!("{base}/v1/traces"))
        .build()
    {
        Ok(exporter) => exporter,
        Err(e) => {
            eprintln!("telemetry: failed to build OTLP span exporter: {e}");
            return None;
        }
    };

    // temporality はデフォルトの cumulative。CloudWatch OTel Metrics を PromQL
    // (rate / histogram_quantile) で読む前提のため Prometheus 同様 cumulative が正。
    let metric_exporter = match opentelemetry_otlp::MetricExporter::builder()
        .with_http()
        .with_protocol(Protocol::HttpBinary)
        .with_endpoint(format!("{base}/v1/metrics"))
        .build()
    {
        Ok(exporter) => exporter,
        Err(e) => {
            eprintln!("telemetry: failed to build OTLP metric exporter: {e}");
            return None;
        }
    };

    let tracer_provider = SdkTracerProvider::builder()
        .with_batch_exporter(span_exporter)
        .with_id_generator(XrayIdGenerator::default())
        .with_resource(resource.clone())
        .build();

    let meter_provider = SdkMeterProvider::builder()
        .with_reader(
            PeriodicReader::builder(metric_exporter)
                .with_interval(Duration::from_secs(60))
                .build(),
        )
        .with_resource(resource)
        .build();

    use opentelemetry::trace::TracerProvider as _;
    let tracer = tracer_provider.tracer("blog-api");

    global::set_meter_provider(meter_provider.clone());
    let _ = PROVIDERS.set((tracer_provider, meter_provider));

    Some(Telemetry { tracer })
}

/// 溜まっている traces / metrics をベストエフォートで export する。
///
/// force_flush は同期ブロックするため、リクエストのレイテンシに乗せないよう
/// 別スレッドで実行する。Lambda が直後に freeze された場合は次の invoke 中に
/// 送信が完了する。
pub fn flush() {
    let Some((tracer_provider, meter_provider)) = PROVIDERS.get() else {
        return;
    };
    let tracer_provider = tracer_provider.clone();
    let meter_provider = meter_provider.clone();
    std::thread::spawn(move || {
        let _ = tracer_provider.force_flush();
        let _ = meter_provider.force_flush();
    });
}

/// プロセス終了前の明示 shutdown (ローカル実行向け。Lambda では呼ばれない)。
pub fn shutdown() {
    if let Some((tracer_provider, meter_provider)) = PROVIDERS.get() {
        let _ = tracer_provider.shutdown();
        let _ = meter_provider.shutdown();
    }
}
