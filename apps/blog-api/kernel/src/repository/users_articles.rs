use async_trait::async_trait;

use crate::model::article::{Article, ArticleSummary, ArticleType};

pub struct ArticleSummaryPage {
    pub articles: Vec<ArticleSummary>,
    pub total_count: u64,
}

#[async_trait]
pub trait UsersArticlesRepository: Send + Sync {
    async fn find_published_by_user_name_and_type(
        &self,
        user_name: &str,
        article_type: &ArticleType,
        offset: u64,
        limit: u64,
    ) -> Result<ArticleSummaryPage, anyhow::Error>;

    async fn find_published_by_user_name_and_slug(
        &self,
        user_name: &str,
        slug: &str,
    ) -> Result<Option<Article>, anyhow::Error>;
}
