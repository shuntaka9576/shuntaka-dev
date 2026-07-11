use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

// ID系のnewtype定義
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ArticleId(Uuid);

impl ArticleId {
    pub fn new(id: Uuid) -> Self {
        Self(id)
    }

    pub fn generate() -> Self {
        Self(Uuid::new_v4())
    }

    pub fn as_uuid(&self) -> &Uuid {
        &self.0
    }

    pub fn into_inner(self) -> Uuid {
        self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct UserId(Uuid);

impl UserId {
    pub fn new(id: Uuid) -> Self {
        Self(id)
    }

    pub fn as_uuid(&self) -> &Uuid {
        &self.0
    }

    pub fn into_inner(self) -> Uuid {
        self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TagId(Uuid);

impl TagId {
    pub fn new(id: Uuid) -> Self {
        Self(id)
    }

    pub fn as_uuid(&self) -> &Uuid {
        &self.0
    }

    pub fn into_inner(self) -> Uuid {
        self.0
    }
}

// 文字列系のnewtype定義
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Title(String);

impl Title {
    pub fn new(value: String) -> Self {
        Self(value)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_inner(self) -> String {
        self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Slug(String);

impl Slug {
    pub fn new(value: String) -> Self {
        Self(value)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_inner(self) -> String {
        self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Content(String);

impl Content {
    pub fn new(value: String) -> Self {
        Self(value)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_inner(self) -> String {
        self.0
    }
}

// webhook upsert 時に事前生成した変換済みHTML
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ContentHtml(String);

impl ContentHtml {
    pub fn new(value: String) -> Self {
        Self(value)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_inner(self) -> String {
        self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Thumbnail(String);

impl Thumbnail {
    pub fn new(value: String) -> Self {
        Self(value)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_inner(self) -> String {
        self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Description(String);

impl Description {
    pub fn new(value: String) -> Self {
        Self(value)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_inner(self) -> String {
        self.0
    }
}

// ステータス用のnewtype定義（バリデーション付き）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Status(String);

impl Status {
    pub fn new(value: String) -> Result<Self, String> {
        if Self::is_valid(&value) {
            Ok(Self(value))
        } else {
            Err(format!("Invalid status: {value}"))
        }
    }

    pub fn draft() -> Self {
        Self("draft".to_string())
    }

    pub fn review() -> Self {
        Self("review".to_string())
    }

    pub fn scheduled() -> Self {
        Self("scheduled".to_string())
    }

    pub fn published() -> Self {
        Self("published".to_string())
    }

    pub fn archived() -> Self {
        Self("archived".to_string())
    }

    pub fn deleted() -> Self {
        Self("deleted".to_string())
    }

    pub fn is_valid(value: &str) -> bool {
        matches!(
            value,
            "draft" | "review" | "scheduled" | "published" | "archived" | "deleted"
        )
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_inner(self) -> String {
        self.0
    }
}

// タグはフルパス表記の文字列で扱う（例: "rust", "aws/lambda", "aws/lambda/snapstart"）。
// DB 上は tags.parent_tag_id の隣接リスト（最大3階層）で、記事との関連は leaf タグのみに張る。

/// タグ絞り込みのモード: AND（全て一致）または OR（いずれか一致）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TagFilterMode {
    And,
    Or,
}

impl TagFilterMode {
    /// 文字列から変換する。"or" 以外はデフォルトの And にフォールバックする。
    pub fn from_str_or_default(s: &str) -> Self {
        if s.eq_ignore_ascii_case("or") {
            Self::Or
        } else {
            Self::And
        }
    }
}

/// タグ絞り込み条件（フルパス表記のタグリスト + モード）
#[derive(Debug, Clone)]
pub struct TagFilter {
    /// フルパス表記のタグパスリスト（例: "tech/aws/lambda"）
    pub paths: Vec<String>,
    pub mode: TagFilterMode,
}

impl TagFilter {
    pub fn new(paths: Vec<String>, mode: TagFilterMode) -> Self {
        Self { paths, mode }
    }

    pub fn is_empty(&self) -> bool {
        self.paths.is_empty()
    }
}

/// タグ名を正規化する: trim + 英字小文字化 + 空要素除去 + sort/dedup
pub fn normalize_tags(tags: &[String]) -> Vec<String> {
    let mut normalized: Vec<String> = tags
        .iter()
        .map(|t| {
            t.split('/')
                .map(|seg| seg.trim().to_lowercase())
                .filter(|seg| !seg.is_empty())
                .collect::<Vec<_>>()
                .join("/")
        })
        .filter(|t| !t.is_empty())
        .collect();
    normalized.sort();
    normalized.dedup();
    normalized
}

/// フルパス表記のタグを祖先→leaf 順のセグメントに分解する。4階層以上はエラー
pub fn parse_tag_path(tag: &str) -> Result<Vec<String>, String> {
    let segments: Vec<String> = tag
        .split('/')
        .map(|seg| seg.trim().to_lowercase())
        .filter(|seg| !seg.is_empty())
        .collect();
    if segments.is_empty() {
        return Err(format!("Empty tag path: {tag}"));
    }
    if segments.len() > 3 {
        return Err(format!("Tag path too deep (max 3 levels): {tag}"));
    }
    Ok(segments)
}

// 一覧用のサマリモデル（content を持たない）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ArticleSummary {
    pub article_id: ArticleId,
    pub title: Title,
    pub slug: Slug,
    pub user_id: UserId,
    pub thumbnail: Option<Thumbnail>,
    pub description: Description,
    pub status: Status,
    pub tags: Vec<String>,
    pub published_at: Option<DateTime<Utc>>,
    pub created_at: Option<DateTime<Utc>>,
    pub updated_at: Option<DateTime<Utc>>,
}

impl ArticleSummary {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        article_id: ArticleId,
        title: Title,
        slug: Slug,
        user_id: UserId,
        thumbnail: Option<Thumbnail>,
        description: Description,
        status: Status,
        tags: Vec<String>,
        published_at: Option<DateTime<Utc>>,
        created_at: Option<DateTime<Utc>>,
        updated_at: Option<DateTime<Utc>>,
    ) -> Self {
        Self {
            article_id,
            title,
            slug,
            user_id,
            thumbnail,
            description,
            status,
            tags,
            published_at,
            created_at,
            updated_at,
        }
    }
}

// Article構造体の完全実装
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Article {
    pub article_id: ArticleId,
    pub title: Title,
    pub slug: Slug,
    pub user_id: UserId,
    pub content: Content,
    pub content_html: Option<ContentHtml>,
    pub thumbnail: Option<Thumbnail>,
    pub description: Description,
    pub status: Status,
    pub tags: Vec<String>,
    pub published_at: Option<DateTime<Utc>>,
    pub created_at: Option<DateTime<Utc>>,
    pub updated_at: Option<DateTime<Utc>>,
}

impl Article {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        article_id: ArticleId,
        title: Title,
        slug: Slug,
        user_id: UserId,
        content: Content,
        content_html: Option<ContentHtml>,
        thumbnail: Option<Thumbnail>,
        description: Description,
        status: Status,
        tags: Vec<String>,
        published_at: Option<DateTime<Utc>>,
        created_at: Option<DateTime<Utc>>,
        updated_at: Option<DateTime<Utc>>,
    ) -> Self {
        Self {
            article_id,
            title,
            slug,
            user_id,
            content,
            content_html,
            thumbnail,
            description,
            status,
            tags,
            published_at,
            created_at,
            updated_at,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_tags() {
        let tags = vec![
            " Rust ".to_string(),
            "AWS/Lambda".to_string(),
            "rust".to_string(),
            "".to_string(),
            " / ".to_string(),
        ];
        assert_eq!(normalize_tags(&tags), vec!["aws/lambda", "rust"]);
    }

    #[test]
    fn test_normalize_tags_keeps_japanese() {
        let tags = vec!["振り返り".to_string(), "登壇".to_string()];
        assert_eq!(normalize_tags(&tags), vec!["振り返り", "登壇"]);
    }

    #[test]
    fn test_parse_tag_path() {
        assert_eq!(parse_tag_path("rust").unwrap(), vec!["rust"]);
        assert_eq!(parse_tag_path("AWS/Lambda").unwrap(), vec!["aws", "lambda"]);
        assert_eq!(
            parse_tag_path("aws/lambda/snapstart").unwrap(),
            vec!["aws", "lambda", "snapstart"]
        );
    }

    #[test]
    fn test_parse_tag_path_too_deep() {
        assert!(parse_tag_path("a/b/c/d").is_err());
    }

    #[test]
    fn test_parse_tag_path_empty() {
        assert!(parse_tag_path("").is_err());
        assert!(parse_tag_path(" / ").is_err());
    }

    #[test]
    fn test_tag_filter_mode_from_str_or_default() {
        assert_eq!(TagFilterMode::from_str_or_default("or"), TagFilterMode::Or);
        assert_eq!(TagFilterMode::from_str_or_default("OR"), TagFilterMode::Or);
        assert_eq!(TagFilterMode::from_str_or_default("Or"), TagFilterMode::Or);
        assert_eq!(
            TagFilterMode::from_str_or_default("and"),
            TagFilterMode::And
        );
        assert_eq!(
            TagFilterMode::from_str_or_default("AND"),
            TagFilterMode::And
        );
        assert_eq!(
            TagFilterMode::from_str_or_default("invalid"),
            TagFilterMode::And
        );
        assert_eq!(TagFilterMode::from_str_or_default(""), TagFilterMode::And);
    }

    #[test]
    fn test_tag_filter_is_empty() {
        let empty = TagFilter::new(vec![], TagFilterMode::And);
        assert!(empty.is_empty());

        let non_empty = TagFilter::new(vec!["tech/rust".to_string()], TagFilterMode::And);
        assert!(!non_empty.is_empty());
    }
}
