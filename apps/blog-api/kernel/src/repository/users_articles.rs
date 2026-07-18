use async_trait::async_trait;

use crate::model::article::{Article, ArticleSummary, TagFilter};

pub struct ArticleSummaryPage {
    pub articles: Vec<ArticleSummary>,
    pub total_count: u64,
}

pub struct ArticleSearchResult {
    pub article: ArticleSummary,
    pub distance: f64,
}

pub struct ArticleSearchResultPage {
    pub results: Vec<ArticleSearchResult>,
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

    /// 公開記事を対象に類似度順のページを返す。方式はモードで分かれる。
    /// * タグなし: HNSW ANN + 固定候補窓（offset 非依存）。total_count は窓内ユニーク記事数
    /// * タグあり: 距離計算前の pre-filter + exact。total_count はファセット件数と一致する真値
    ///
    /// どちらも total_count は offset 非依存で安定し、順序も決定的
    /// （distance + article_id タイブレーク）なので LIMIT/OFFSET ページネーションが成立する。
    async fn search_published_by_user_name(
        &self,
        user_name: &str,
        vector: &[f32],
        tag_filter: Option<&TagFilter>,
        limit: u64,
        offset: u64,
    ) -> Result<ArticleSearchResultPage, anyhow::Error>;

    async fn find_tag_facets(
        &self,
        user_name: &str,
        tag_filter: Option<&TagFilter>,
    ) -> Result<TagFacetsResult, anyhow::Error>;
}
