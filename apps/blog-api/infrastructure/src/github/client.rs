use async_trait::async_trait;
use base64::Engine;
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use reqwest::Client;

use crate::error::GitHubError;
use crate::github::types::{AccessTokenResponse, GitHubContentItem, GitHubFileContent, JwtClaims};
use crate::observability::observe_external_request;

#[async_trait]
pub trait GitHubAppClient: Send + Sync {
    async fn get_access_token(&self, installation_id: i64) -> Result<String, GitHubError>;

    async fn list_contents(
        &self,
        owner: &str,
        repo: &str,
        path: &str,
        token: &str,
    ) -> Result<Vec<GitHubContentItem>, GitHubError>;

    async fn get_content(
        &self,
        owner: &str,
        repo: &str,
        path: &str,
        token: &str,
    ) -> Result<GitHubFileContent, GitHubError>;

    fn decode_content(&self, content: &GitHubFileContent) -> Result<String, GitHubError>;
}

pub struct GitHubAppClientImpl {
    http_client: Client,
    app_id: String,
    private_key: String,
}

impl GitHubAppClientImpl {
    pub fn new(app_id: String, private_key: String) -> Self {
        Self {
            http_client: Client::new(),
            app_id,
            private_key,
        }
    }

    fn generate_jwt(&self) -> Result<String, GitHubError> {
        let now = chrono::Utc::now().timestamp();
        let claims = JwtClaims {
            iat: now - 10,
            exp: now + 60,
            iss: self.app_id.clone(),
        };

        let key = EncodingKey::from_rsa_pem(self.private_key.as_bytes())?;
        encode(&Header::new(Algorithm::RS256), &claims, &key).map_err(GitHubError::from)
    }
}

#[async_trait]
impl GitHubAppClient for GitHubAppClientImpl {
    async fn get_access_token(&self, installation_id: i64) -> Result<String, GitHubError> {
        let jwt = self.generate_jwt()?;

        observe_external_request(
            "github",
            "get_access_token",
            "POST",
            "app/installations/{installation_id}/access_tokens",
            async {
                let response = self
                    .http_client
                    .post(format!(
                        "https://api.github.com/app/installations/{installation_id}/access_tokens"
                    ))
                    .header("Authorization", format!("Bearer {jwt}"))
                    .header("Accept", "application/vnd.github.v3+json")
                    .header("User-Agent", "blog-api")
                    .send()
                    .await?;

                if !response.status().is_success() {
                    let status = response.status().as_u16();
                    let message = response.text().await.unwrap_or_default();
                    return Err(GitHubError::Api { status, message });
                }

                let body: AccessTokenResponse = response.json().await?;
                Ok(body.token)
            },
        )
        .await
    }

    async fn list_contents(
        &self,
        owner: &str,
        repo: &str,
        path: &str,
        token: &str,
    ) -> Result<Vec<GitHubContentItem>, GitHubError> {
        observe_external_request(
            "github",
            "list_contents",
            "GET",
            "repos/{owner}/{repo}/contents/{path}",
            async {
                let response = self
                    .http_client
                    .get(format!(
                        "https://api.github.com/repos/{owner}/{repo}/contents/{path}"
                    ))
                    .header("Authorization", format!("token {token}"))
                    .header("Accept", "application/vnd.github.v3+json")
                    .header("User-Agent", "blog-api")
                    .send()
                    .await?;

                if !response.status().is_success() {
                    let status = response.status().as_u16();
                    let message = response.text().await.unwrap_or_default();
                    return Err(GitHubError::Api { status, message });
                }

                response.json().await.map_err(GitHubError::from)
            },
        )
        .await
    }

    async fn get_content(
        &self,
        owner: &str,
        repo: &str,
        path: &str,
        token: &str,
    ) -> Result<GitHubFileContent, GitHubError> {
        observe_external_request(
            "github",
            "get_content",
            "GET",
            "repos/{owner}/{repo}/contents/{path}",
            async {
                let response = self
                    .http_client
                    .get(format!(
                        "https://api.github.com/repos/{owner}/{repo}/contents/{path}"
                    ))
                    .header("Authorization", format!("token {token}"))
                    .header("Accept", "application/vnd.github.v3+json")
                    .header("User-Agent", "blog-api")
                    .send()
                    .await?;

                if !response.status().is_success() {
                    let status = response.status().as_u16();
                    let message = response.text().await.unwrap_or_default();
                    return Err(GitHubError::Api { status, message });
                }

                response.json().await.map_err(GitHubError::from)
            },
        )
        .await
    }

    fn decode_content(&self, content: &GitHubFileContent) -> Result<String, GitHubError> {
        let cleaned = content.content.replace(['\n', '\r'], "");
        let decoded = base64::engine::general_purpose::STANDARD.decode(cleaned)?;
        String::from_utf8(decoded).map_err(GitHubError::from)
    }
}
