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
        current.record("http.response.status_code", status.as_u16());
        current.record("http.status_code", status.as_u16());
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
