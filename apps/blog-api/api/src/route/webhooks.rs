use axum::{Router, routing::post};
use registry::AppRegistry;

use crate::handler::webhooks::{handle_github_webhook, handle_lambda_events};

pub fn build_webhooks_routers() -> Router<AppRegistry> {
    Router::new()
        .route("/webhooks/github", post(handle_github_webhook))
        // Lambda Web Adapter が自己 Event invoke のペイロードを転送してくる受け口
        // (AWS_LWA_PASS_THROUGH_PATH)。ハンドラー内で GitHub 署名を再検証する。
        .route("/events", post(handle_lambda_events))
}
