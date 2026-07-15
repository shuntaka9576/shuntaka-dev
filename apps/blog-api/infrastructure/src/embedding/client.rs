use std::time::Duration;

use async_trait::async_trait;
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};

use crate::error::EmbeddingError;
use crate::observability::observe_external_request;

const EXPECTED_DIMENSION: usize = 2048;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

#[async_trait]
pub trait EmbeddingClient: Send + Sync {
    async fn embed_query(&self, text: &str) -> Result<Vec<f32>, EmbeddingError>;
    async fn embed_document(&self, text: &str) -> Result<Vec<f32>, EmbeddingError>;
}

pub struct EmbeddingClientImpl {
    http_client: Client,
    endpoint: Url,
}

#[derive(Serialize)]
struct EmbedRequest<'a> {
    text: &'a str,
    mode: &'static str,
}

#[derive(Debug, Deserialize)]
struct EmbedResponse {
    vector: Vec<f32>,
    dim: usize,
}

impl EmbeddingClientImpl {
    pub fn new(base_url: &str) -> Result<Self, EmbeddingError> {
        let mut endpoint = Url::parse(base_url)
            .map_err(|error| EmbeddingError::InvalidEndpoint(error.to_string()))?;
        if endpoint.scheme() != "http" && endpoint.scheme() != "https" {
            return Err(EmbeddingError::InvalidEndpoint(
                "scheme must be http or https".to_string(),
            ));
        }
        let base_path = endpoint.path().trim_end_matches('/');
        endpoint.set_path(&format!("{base_path}/embed"));
        endpoint.set_query(None);
        endpoint.set_fragment(None);

        let http_client = Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(EmbeddingError::HttpClient)?;
        Ok(Self {
            http_client,
            endpoint,
        })
    }

    fn validate_response(response: EmbedResponse) -> Result<Vec<f32>, EmbeddingError> {
        if response.dim != response.vector.len() {
            return Err(EmbeddingError::InvalidResponse(format!(
                "dim does not match vector length: dim={}, length={}",
                response.dim,
                response.vector.len()
            )));
        }
        if response.vector.len() != EXPECTED_DIMENSION {
            return Err(EmbeddingError::InvalidResponse(format!(
                "unexpected dimension: expected={EXPECTED_DIMENSION}, actual={}",
                response.vector.len()
            )));
        }
        if response.vector.iter().any(|value| !value.is_finite()) {
            return Err(EmbeddingError::InvalidResponse(
                "vector contains a non-finite value".to_string(),
            ));
        }
        Ok(response.vector)
    }

    async fn embed(&self, text: &str, mode: &'static str) -> Result<Vec<f32>, EmbeddingError> {
        observe_external_request("plamo", mode, "POST", "/embed", async {
            let response = self
                .http_client
                .post(self.endpoint.clone())
                .json(&EmbedRequest { text, mode })
                .send()
                .await?;

            if !response.status().is_success() {
                let status = response.status().as_u16();
                let message: String = response.text().await?.chars().take(500).collect();
                return Err(EmbeddingError::Api { status, message });
            }

            Self::validate_response(response.json::<EmbedResponse>().await?)
        })
        .await
    }
}

#[async_trait]
impl EmbeddingClient for EmbeddingClientImpl {
    async fn embed_query(&self, text: &str) -> Result<Vec<f32>, EmbeddingError> {
        self.embed(text, "query").await
    }

    async fn embed_document(&self, text: &str) -> Result<Vec<f32>, EmbeddingError> {
        self.embed(text, "document").await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_appends_embed_path() {
        let client = EmbeddingClientImpl::new("http://localhost:8080/base/").unwrap();
        assert_eq!(client.endpoint.as_str(), "http://localhost:8080/base/embed");
    }

    #[test]
    fn endpoint_rejects_non_http_scheme() {
        assert!(EmbeddingClientImpl::new("file:///tmp/embed").is_err());
    }

    #[test]
    fn response_rejects_dimension_mismatch() {
        let response = EmbedResponse {
            vector: vec![0.0; EXPECTED_DIMENSION],
            dim: EXPECTED_DIMENSION - 1,
        };
        assert!(EmbeddingClientImpl::validate_response(response).is_err());
    }

    #[test]
    fn response_accepts_expected_dimension() {
        let response = EmbedResponse {
            vector: vec![0.0; EXPECTED_DIMENSION],
            dim: EXPECTED_DIMENSION,
        };
        assert_eq!(
            EmbeddingClientImpl::validate_response(response)
                .unwrap()
                .len(),
            EXPECTED_DIMENSION
        );
    }
}
