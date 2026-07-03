//! 外部サービス呼び出し (GitHub 等) の OTel 計装ヘルパー。
//!
//! `external.request` span で外部 API のクライアント側レイテンシを記録する。
//! webhook 処理の遅延が DB 側か外部 API 側かを切り分けるのが目的。
//!
//! span 属性にはトークン・署名・レスポンスボディを入れない。URL は実値ではなく
//! 低カーディナリティのテンプレート文字列 (`url.template`) で識別する。

use std::future::Future;

use tracing::Instrument;

/// 外部 API 呼び出し future を `external.request` span で包む。
///
/// - `service`: `github` のような論理サービス名
/// - `operation`: `get_access_token` のような呼び出し側メソッド名
/// - `method`: HTTP メソッド
/// - `url_template`: `repos/{owner}/{repo}/contents/{path}` のようなテンプレート
pub async fn observe_external_request<T, E, F>(
    service: &'static str,
    operation: &'static str,
    method: &'static str,
    url_template: &'static str,
    fut: F,
) -> Result<T, E>
where
    F: Future<Output = Result<T, E>>,
    E: std::fmt::Display,
{
    let span = tracing::info_span!(
        "external.request",
        otel.kind = "client",
        peer.service = service,
        external.operation = operation,
        http.request.method = method,
        url.template = url_template,
        otel.status_code = tracing::field::Empty,
        error.message = tracing::field::Empty,
    );

    let result = fut.instrument(span.clone()).await;

    if let Err(e) = &result {
        span.record("otel.status_code", "ERROR");
        span.record("error.message", tracing::field::display(e));
    }

    result
}
