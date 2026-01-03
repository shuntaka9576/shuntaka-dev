use axum::{extract::State, http::StatusCode};
use registry::AppRegistry;

#[utoipa::path(
    get,
    path = "/health",
    responses(
        (status = 204, description = "Service is healthy")
    ),
    tag = "health"
)]
pub async fn health_check() -> StatusCode {
    StatusCode::NO_CONTENT
}

#[utoipa::path(
    get,
    path = "/health/db",
    responses(
        (status = 204, description = "Database connection is healthy"),
        (status = 500, description = "Database connection failed")
    ),
    tag = "health"
)]
pub async fn health_check_db(State(registry): State<AppRegistry>) -> StatusCode {
    if registry.health_check_repository().check_db().await {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    }
}
