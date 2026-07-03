//! リクエスト単位の OTel 計装ミドルウェア。
//!
//! Lambda Web Adapter 経由では 1 HTTP リクエスト = 1 Lambda invoke なので、
//! この span (`lambda.handler`) がトレースのルートになり、配下に `db.query` /
//! `db.connect` 等の子 span がぶら下がる。
//!
//! `Router::route_layer` で適用する前提 (ルーティング後に実行されるため
//! `MatchedPath` が取れる。未マッチの 404 には適用されない)。

use std::sync::LazyLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use axum::extract::{MatchedPath, Request};
use axum::middleware::Next;
use axum::response::Response;
use opentelemetry::KeyValue;
use opentelemetry::global;
use opentelemetry::metrics::{Counter, Histogram};
use tracing::Instrument;

static COLD_START: AtomicBool = AtomicBool::new(true);

static REQUEST_DURATION: LazyLock<Histogram<f64>> = LazyLock::new(|| {
    global::meter("blog-api")
        .f64_histogram("app.request.duration")
        .with_unit("ms")
        .with_description("End-to-end Lambda request duration (handler)")
        .with_boundaries(vec![
            1.0, 2.0, 5.0, 10.0, 20.0, 30.0, 50.0, 75.0, 100.0, 150.0, 200.0, 300.0, 500.0, 750.0,
            1000.0, 1500.0, 2000.0, 3000.0, 5000.0, 10000.0, 30000.0,
        ])
        .build()
});

static COLD_START_COUNT: LazyLock<Counter<u64>> = LazyLock::new(|| {
    global::meter("blog-api")
        .u64_counter("lambda.cold_start.count")
        .with_description("Lambda cold start count")
        .build()
});

/// 全ルート共通のリクエスト計装。`lambda.handler` span を張り、
/// `app.request.duration` histogram と cold start counter を記録する。
pub async fn observe_request(req: Request, next: Next) -> Response {
    let route = req
        .extensions()
        .get::<MatchedPath>()
        .map(|m| m.as_str().to_owned())
        .unwrap_or_else(|| req.uri().path().to_owned());
    let method = req.method().as_str().to_owned();

    // プロセス起動後の最初のリクエスト = cold start 起因のリクエスト。
    let cold_start = COLD_START.swap(false, Ordering::Relaxed);
    if cold_start {
        COLD_START_COUNT.add(1, &[]);
    }

    let span = tracing::info_span!(
        "lambda.handler",
        otel.kind = "server",
        app.route = %route,
        http.request.method = %method,
        cold_start = cold_start,
        http.response.status_code = tracing::field::Empty,
        // ADOT collector (awsxray exporter) が旧 semconv キーしか見ない場合でも
        // X-Ray セグメントの http.response.status に反映されるよう旧キーも併記する
        http.status_code = tracing::field::Empty,
        otel.status_code = tracing::field::Empty,
    );

    let start = Instant::now();
    // status は span が生きている instrument スコープ内で record し、
    // await 完了 = span の最後のハンドル drop で flush() より前に確実に close させる。
    // close 前に flush が走ると、このリクエストの span 自体が今回の export に
    // 乗らない (次の invoke まで持ち越される) ため。
    let response = async {
        let response = next.run(req).await;
        let status = response.status();
        let current = tracing::Span::current();
        // i64 で record する。u16/u64 のままだと tracing-opentelemetry (0.33) が
        // record_u64 未実装のため Debug 文字列になり、ADOT の awsxray translator の
        // Value.Int() が 0 を返して X-Ray の http.response.status が 0 に化ける
        current.record("http.response.status_code", i64::from(status.as_u16()));
        current.record("http.status_code", i64::from(status.as_u16()));
        if status.is_server_error() {
            current.record("otel.status_code", "ERROR");
        }
        response
    }
    .instrument(span)
    .await;
    let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;

    REQUEST_DURATION.record(
        elapsed_ms,
        &[
            KeyValue::new("app.route", route),
            KeyValue::new("cold_start", cold_start),
        ],
    );

    // Lambda は応答後すぐ freeze され得るため、バックグラウンド export に頼らず
    // ここでベストエフォート flush を仕掛ける (レイテンシには乗せない)。
    shared::telemetry::flush();

    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Router;
    use axum::body::Body;
    use axum::http::Request as HttpRequest;
    use axum::routing::get;
    use opentelemetry::trace::TracerProvider as _;
    use opentelemetry_sdk::trace::{InMemorySpanExporter, SdkTracerProvider};
    use tower::ServiceExt;
    use tracing::Level;
    use tracing_subscriber::Layer;
    use tracing_subscriber::filter::Targets;
    use tracing_subscriber::layer::SubscriberExt;

    /// 本番 (src/bin/app.rs) と同じ「Targets フィルタ付き otel layer」構成で、
    /// export された lambda.handler span に後から record した status が
    /// 乗ることを検証する回帰テスト。
    /// X-Ray で http.response.status が 0 になる問題の切り分け用。
    #[tokio::test]
    async fn lambda_handler_span_exports_response_status() {
        let exporter = InMemorySpanExporter::default();
        let provider = SdkTracerProvider::builder()
            .with_simple_exporter(exporter.clone())
            .build();
        let tracer = provider.tracer("test");

        let subscriber = tracing_subscriber::registry().with(
            tracing_opentelemetry::layer().with_tracer(tracer).with_filter(
                Targets::new()
                    .with_target("api", Level::INFO)
                    .with_target("adapter", Level::INFO),
            ),
        );
        let _guard = tracing::subscriber::set_default(subscriber);

        let app = Router::new()
            .route("/ping", get(|| async { "pong" }))
            .route_layer(axum::middleware::from_fn(observe_request));

        let response = app
            .oneshot(HttpRequest::get("/ping").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);

        provider.force_flush().unwrap();
        let spans = exporter.get_finished_spans().unwrap();
        let handler = spans
            .iter()
            .find(|s| s.name == "lambda.handler")
            .unwrap_or_else(|| panic!("lambda.handler span not exported: {spans:?}"));

        let attr = |key: &str| {
            handler
                .attributes
                .iter()
                .find(|kv| kv.key.as_str() == key)
                .map(|kv| kv.value.clone())
        };
        // 値の「型」まで検証する。u16 のまま record すると tracing-opentelemetry が
        // record_u64 を実装していないため Debug 文字列 ("200") になり、ADOT の
        // awsxray translator の Value.Int() が 0 を返して X-Ray の status が 0 になる
        assert_eq!(
            attr("http.response.status_code"),
            Some(opentelemetry::Value::I64(200)),
            "attributes: {:?}",
            handler.attributes
        );
        assert_eq!(
            attr("http.status_code"),
            Some(opentelemetry::Value::I64(200))
        );
        assert_eq!(
            attr("app.route"),
            Some(opentelemetry::Value::from("/ping".to_string()))
        );
    }
}
