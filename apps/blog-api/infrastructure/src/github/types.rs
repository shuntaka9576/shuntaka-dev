use serde::{Deserialize, Serialize};

/// GitHub Push Event from webhook
#[derive(Debug, Clone, Deserialize)]
pub struct PushEvent {
    #[serde(rename = "ref")]
    pub git_ref: String,
    pub repository: Repository,
    pub installation: Installation,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Repository {
    pub name: String,
    pub full_name: String,
    pub owner: Owner,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Owner {
    pub name: Option<String>,
    pub login: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Installation {
    pub id: i64,
}

/// GitHub content list item (directory listing)
#[derive(Debug, Clone, Deserialize)]
pub struct GitHubContentItem {
    #[serde(rename = "type")]
    pub content_type: String,
    pub name: String,
    pub path: String,
    pub sha: String,
    pub size: u64,
    pub download_url: Option<String>,
}

/// GitHub file content (single file)
#[derive(Debug, Clone, Deserialize)]
pub struct GitHubFileContent {
    pub name: String,
    pub path: String,
    pub content: String,
    pub encoding: String,
    pub sha: String,
}

/// Access token response from GitHub App
#[derive(Debug, Clone, Deserialize)]
pub struct AccessTokenResponse {
    pub token: String,
    pub expires_at: String,
}

/// JWT claims for GitHub App authentication
#[derive(Debug, Serialize)]
pub struct JwtClaims {
    pub iat: i64,
    pub exp: i64,
    pub iss: String,
}
