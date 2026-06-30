use async_trait::async_trait;

use crate::model::article::{Article, ArticleSummary, ArticleType};

#[async_trait]
pub trait UsersArticlesRepository: Send + Sync {
    async fn find_published_by_user_name_and_type(
        &self,
        user_name: &str,
        article_type: &ArticleType,
    ) -> Result<Vec<ArticleSummary>, anyhow::Error>;

    async fn find_published_by_user_name_and_slug(
        &self,
        user_name: &str,
        slug: &str,
    ) -> Result<Option<Article>, anyhow::Error>;
}
