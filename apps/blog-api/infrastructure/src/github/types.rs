use serde::{Deserialize, Serialize};

/// GitHub Push Event from webhook
#[derive(Debug, Clone, Deserialize)]
pub struct PushEvent {
    #[serde(rename = "ref")]
    pub git_ref: String,
    /// push 後の HEAD コミット SHA。labs 同期の Git Trees API 呼び出しで使う
    /// (ブランチ名だと後続の push と競合しうるため、この時点のコミットを固定で参照する)。
    pub after: String,
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

/// Git Trees API (recursive) のレスポンス。labs/ 配下をネストごと 1 リクエストで
/// 列挙するために使う (contents API と異なりディレクトリを再帰的に辿らずに済む)。
#[derive(Debug, Clone, Deserialize)]
pub struct GitTreeResponse {
    pub sha: String,
    pub tree: Vec<GitTreeItem>,
    /// true の場合 tree が 7MB / 10万エントリ等の上限で切り詰められている。
    /// labs/ 程度の規模では想定しないが、呼び出し側で warn ログを出す判断に使える。
    #[serde(default)]
    pub truncated: bool,
}

/// Git Trees API の 1 エントリ。"blob" (ファイル) と "tree" (ディレクトリ) を含む。
#[derive(Debug, Clone, Deserialize)]
pub struct GitTreeItem {
    pub path: String,
    #[serde(rename = "type")]
    pub item_type: String,
    pub sha: String,
}
