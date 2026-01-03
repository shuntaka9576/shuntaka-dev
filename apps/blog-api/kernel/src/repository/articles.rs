use async_trait::async_trait;

use crate::model::article::{Article, ArticleId, Slug, UserId};

/// Input data for creating or updating an article
#[derive(Debug, Clone)]
pub struct UpsertArticleInput {
    pub user_id: UserId,
    pub slug: Slug,
    pub title: String,
    pub content: String,
    pub description: Option<String>,
    pub thumbnail: Option<String>,
    pub article_type: String,
    pub should_publish: bool,
}

/// Result of article upsert operation
#[derive(Debug, Clone)]
pub enum UpsertResult {
    Created(ArticleId),
    Updated(ArticleId),
    NoChange(ArticleId),
}

#[async_trait]
pub trait ArticlesRepository: Send + Sync {
    /// Find article by user_id and slug
    async fn find_by_user_id_and_slug(
        &self,
        user_id: &UserId,
        slug: &str,
    ) -> Result<Option<Article>, anyhow::Error>;

    /// Create or update an article
    async fn upsert_article(&self, input: UpsertArticleInput)
        -> Result<UpsertResult, anyhow::Error>;
}
