use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct ErrorBody {
    pub error: String,
    pub message: String,
}

#[derive(Debug)]
pub struct AppError {
    pub status: StatusCode,
    pub message: String,
    pub source: Option<anyhow::Error>,
}

impl AppError {
    pub fn internal(msg: &str, source: impl Into<anyhow::Error>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: msg.to_string(),
            source: Some(source.into()),
        }
    }

    pub fn bad_request(msg: &str) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: msg.to_string(),
            source: None,
        }
    }

    pub fn bad_request_with(msg: &str, source: impl Into<anyhow::Error>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: msg.to_string(),
            source: Some(source.into()),
        }
    }

    pub fn not_found(msg: &str) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: msg.to_string(),
            source: None,
        }
    }

    pub fn unauthorized(msg: &str) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            message: msg.to_string(),
            source: None,
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        if self.status.is_server_error() {
            if let Some(ref source) = self.source {
                tracing::error!(status = %self.status, error = %source, "{}", self.message);
            } else {
                tracing::error!(status = %self.status, "{}", self.message);
            }
        }

        let body = ErrorBody {
            error: self
                .status
                .canonical_reason()
                .unwrap_or("UNKNOWN")
                .to_string(),
            message: if self.status.is_server_error() {
                "Internal server error".to_string()
            } else {
                self.message
            },
        };

        (self.status, Json(body)).into_response()
    }
}
