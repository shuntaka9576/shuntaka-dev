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

// 記事タイプ用のnewtype定義（バリデーション付き）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ArticleType(String);

impl ArticleType {
    pub fn new(value: String) -> Result<Self, String> {
        if Self::is_valid(&value) {
            Ok(Self(value))
        } else {
            Err(format!("Invalid article type: {value}"))
        }
    }

    pub fn tech() -> Self {
        Self("tech".to_string())
    }

    pub fn note() -> Self {
        Self("note".to_string())
    }

    pub fn is_valid(value: &str) -> bool {
        matches!(value, "tech" | "note")
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
    pub article_type: Option<ArticleType>,
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
        article_type: Option<ArticleType>,
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
            article_type,
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
    pub thumbnail: Option<Thumbnail>,
    pub description: Description,
    pub status: Status,
    pub article_type: Option<ArticleType>,
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
        thumbnail: Option<Thumbnail>,
        description: Description,
        status: Status,
        article_type: Option<ArticleType>,
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
            thumbnail,
            description,
            status,
            article_type,
            published_at,
            created_at,
            updated_at,
        }
    }
}
