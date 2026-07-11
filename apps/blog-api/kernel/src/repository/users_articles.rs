use async_trait::async_trait;

use crate::model::article::{Article, ArticleSummary, TagFilter};

pub struct ArticleSummaryPage {
    pub articles: Vec<ArticleSummary>,
    pub total_count: u64,
}

pub struct TagFacet {
    pub path: String,
    pub count: u64,
}

pub struct TagFacetsResult {
    pub facets: Vec<TagFacet>,
}

#[async_trait]
pub trait UsersArticlesRepository: Send + Sync {
    async fn find_published_by_user_name(
        &self,
        user_name: &str,
        tag_filter: Option<&TagFilter>,
        offset: u64,
        limit: u64,
    ) -> Result<ArticleSummaryPage, anyhow::Error>;

    async fn find_published_by_user_name_and_slug(
        &self,
        user_name: &str,
        slug: &str,
    ) -> Result<Option<Article>, anyhow::Error>;

    async fn find_tag_facets(
        &self,
        user_name: &str,
        tag_filter: Option<&TagFilter>,
    ) -> Result<TagFacetsResult, anyhow::Error>;
}
