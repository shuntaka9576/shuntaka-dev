use axum::{Router, routing::post};
use registry::AppRegistry;

use crate::handler::webhooks::handle_github_webhook;

pub fn build_webhooks_routers() -> Router<AppRegistry> {
    Router::new().route("/webhooks/github", post(handle_github_webhook))
}
