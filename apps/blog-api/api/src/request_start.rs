//! リクエストが実行環境の初期化を待ったか (cold start) を判定し、1 リクエスト 1 行の JSON ログに出す。
//!
//! 初期化を待たされたリクエストは、実行環境が受け付けを始めた (listen した) 直後にまとめて渡される。
//! そこで listen した時刻を持っておき、そこから `COLD_START_WINDOW_MS` 未満に受けたリクエストを cold start とする。
//! 「プロセス起動後の最初のリクエスト」では判定しない。Lambda は需要より先に実行環境を立ち上げる
//! (Web Functions の headroom、Event Functions の事前の初期化) ため、最初のリクエストでも待っていないことがあり、
//! 初期化中に並列で届いた 2 件目以降は待っていても数えられないため。
//!
//! ログストリームは実行環境ごとに分かれ、platform.* (initReport など) も同じストリームに入る。
//! 実行環境の単位で集計するときは `@logStream` でまとめる (ストリーム名の ID は instanceId とは別の値)。
//! 集計のクエリは docs/source/01_開発ドキュメント/04_operations.md の「cold start の調べ方」を参照。

use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use axum::extract::Request;
use axum::middleware::Next;
use axum::response::Response;
use serde_json::json;

/// listen からこの時間未満に受けたリクエストを cold start とする。2026-10 の本番の実測 (437 環境) では、
/// listen から最初のリクエストまでの時間はほとんどが 20 ms 未満か 1 秒以上に分かれた (20 ms〜1 秒は 2 環境)
const COLD_START_WINDOW_MS: i64 = 1_000;

static STARTED_AT_MS: OnceLock<u64> = OnceLock::new();
static READY_AT_MS: OnceLock<u64> = OnceLock::new();
static SEQ: AtomicU64 = AtomicU64::new(0);
static IN_FLIGHT: AtomicU64 = AtomicU64::new(0);

/// リクエストごとの判定結果。`observe_request` が OTel の `cold_start` に使うため extension に入れる
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RequestStart {
    pub cold_start: bool,
    /// この実行環境で何番目のリクエストか (1 始まり)
    pub seq: u64,
    /// listen してからこのリクエストを受けるまで
    pub since_ready_ms: Option<i64>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// プロセスの起動時刻を記録する。main の先頭で呼ぶ
pub fn mark_started() {
    STARTED_AT_MS.get_or_init(now_ms);
}

/// 受け付けを始めた (listen した) 時刻を記録し、実行環境ごとに 1 行 `app.ready` を出す。bind の直後に呼ぶ
pub fn mark_ready() {
    let ready = *READY_AT_MS.get_or_init(now_ms);
    let started = *STARTED_AT_MS.get_or_init(|| ready);
    println!(
        "{}",
        json!({
            "type": "app.ready",
            "startedAtMs": started,
            "readyAtMs": ready,
            "initMs": ready.saturating_sub(started),
        })
    );
}

fn classify(ready_ms: Option<u64>, received_ms: u64, seq: u64) -> RequestStart {
    let since_ready_ms = ready_ms.map(|ready| received_ms as i64 - ready as i64);
    RequestStart {
        cold_start: since_ready_ms.is_some_and(|ms| ms < COLD_START_WINDOW_MS),
        seq,
        since_ready_ms,
    }
}

/// 応答を返さずに future が drop されても (クライアントの切断など) 並列数を戻す
struct InFlightGuard;

impl InFlightGuard {
    fn enter() -> (Self, u64) {
        (Self, IN_FLIGHT.fetch_add(1, Ordering::Relaxed) + 1)
    }
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        IN_FLIGHT.fetch_sub(1, Ordering::Relaxed);
    }
}

fn header(req: &Request, name: &str) -> Option<String> {
    req.headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
}

/// 全リクエストに cold start の判定を付け、`app.request` を 1 行出す。
/// 未マッチの 404 も数えるため `Router::layer` の一番外側で適用する
pub async fn record_request_start(mut req: Request, next: Next) -> Response {
    let received_ms = now_ms();
    let timer = Instant::now();
    let seq = SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    let (_guard, in_flight) = InFlightGuard::enter();
    let start = classify(READY_AT_MS.get().copied(), received_ms, seq);
    let method = req.method().as_str().to_owned();
    let path = req.uri().path().to_owned();
    // レスポンスヘッダーの lambda-web-request-id と platform.requestComplete の requestId と同じ値
    let request_id = header(&req, "lambda-web-request-id");
    // CloudFront の標準ログ (x-edge-request-id) と突き合わせるため
    let cf_id = header(&req, "x-amz-cf-id");
    req.extensions_mut().insert(start);

    let response = next.run(req).await;

    println!(
        "{}",
        json!({
            "type": "app.request",
            "coldStart": u8::from(start.cold_start),
            "sinceReadyMs": start.since_ready_ms,
            "seq": start.seq,
            "inFlight": in_flight,
            "method": method,
            "path": path,
            "status": response.status().as_u16(),
            // 応答ヘッダーを返すまで (body のストリーミングは含まない)
            "durationMs": timer.elapsed().as_millis() as u64,
            "requestId": request_id,
            "cfId": cf_id,
        })
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_right_after_ready_is_cold_start() {
        // 初期化を待ったリクエストは listen の直後に渡される
        let start = classify(Some(1_000), 1_004, 1);
        assert_eq!(
            start,
            RequestStart {
                cold_start: true,
                seq: 1,
                since_ready_ms: Some(4),
            }
        );
    }

    #[test]
    fn concurrent_requests_during_init_are_all_cold() {
        // 初期化中に並列で届いた 2 件目も待っている
        assert!(classify(Some(1_000), 1_006, 2).cold_start);
    }

    #[test]
    fn first_request_long_after_ready_is_warm() {
        // 先に立ち上がっていた実行環境なら、最初のリクエストでも cold start ではない
        let start = classify(Some(1_000), 61_000, 1);
        assert!(!start.cold_start);
        assert_eq!(start.since_ready_ms, Some(60_000));
    }

    #[test]
    fn window_boundary() {
        assert!(classify(Some(0), 999, 1).cold_start);
        assert!(!classify(Some(0), 1_000, 1).cold_start);
    }

    #[test]
    fn without_ready_is_warm() {
        let start = classify(None, 1_000, 1);
        assert!(!start.cold_start);
        assert_eq!(start.since_ready_ms, None);
    }

    #[tokio::test]
    async fn middleware_passes_start_to_handlers() {
        use axum::Router;
        use axum::body::Body;
        use axum::extract::Extension;
        use axum::routing::get;
        use tower::ServiceExt;

        mark_ready();
        let app = Router::new()
            .route(
                "/start",
                get(|Extension(start): Extension<RequestStart>| async move {
                    format!("{} {}", start.cold_start, start.seq)
                }),
            )
            .layer(axum::middleware::from_fn(record_request_start));

        let request = axum::http::Request::get("/start")
            .header("lambda-web-request-id", "test-request-id")
            .body(Body::empty())
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        // listen の直後なので cold start
        assert!(
            String::from_utf8(bytes.to_vec())
                .unwrap()
                .starts_with("true ")
        );
    }
}
