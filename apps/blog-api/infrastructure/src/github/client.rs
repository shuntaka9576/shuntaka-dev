use async_trait::async_trait;
use base64::Engine;
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use reqwest::Client;

use crate::error::GitHubError;
use crate::github::types::{
    AccessTokenResponse, GitHubContentItem, GitHubFileContent, GitTreeResponse, JwtClaims,
};
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

    /// labs 同期用。git_ref (push イベントの after SHA またはブランチ名) 配下の
    /// ファイルツリーを再帰的に 1 リクエストで取得する。images/ のようなネストした
    /// ディレクトリも contents API を辿らず一括で列挙できる。
    async fn get_tree_recursive(
        &self,
        owner: &str,
        repo: &str,
        git_ref: &str,
        token: &str,
    ) -> Result<GitTreeResponse, GitHubError>;

    /// labs 同期用。blob sha からファイルの生バイト列を取得する (画像用)。
    /// get_content の base64 (1MB 制限) と異なり raw Accept ヘッダーでサイズ制限なく取得する。
    async fn get_blob_raw(
        &self,
        owner: &str,
        repo: &str,
        file_sha: &str,
        token: &str,
    ) -> Result<Vec<u8>, GitHubError>;
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

    async fn get_tree_recursive(
        &self,
        owner: &str,
        repo: &str,
        git_ref: &str,
        token: &str,
    ) -> Result<GitTreeResponse, GitHubError> {
        observe_external_request(
            "github",
            "get_tree_recursive",
            "GET",
            "repos/{owner}/{repo}/git/trees/{ref}",
            async {
                let response = self
                    .http_client
                    .get(format!(
                        "https://api.github.com/repos/{owner}/{repo}/git/trees/{git_ref}?recursive=1"
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

    async fn get_blob_raw(
        &self,
        owner: &str,
        repo: &str,
        file_sha: &str,
        token: &str,
    ) -> Result<Vec<u8>, GitHubError> {
        observe_external_request(
            "github",
            "get_blob_raw",
            "GET",
            "repos/{owner}/{repo}/git/blobs/{sha}",
            async {
                let response = self
                    .http_client
                    .get(format!(
                        "https://api.github.com/repos/{owner}/{repo}/git/blobs/{file_sha}"
                    ))
                    .header("Authorization", format!("token {token}"))
                    .header("Accept", "application/vnd.github.raw+json")
                    .header("User-Agent", "blog-api")
                    .send()
                    .await?;

                if !response.status().is_success() {
                    let status = response.status().as_u16();
                    let message = response.text().await.unwrap_or_default();
                    return Err(GitHubError::Api { status, message });
                }

                let bytes = response.bytes().await?;
                Ok(bytes.to_vec())
            },
        )
        .await
    }
}
