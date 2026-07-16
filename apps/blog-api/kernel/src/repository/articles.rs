use async_trait::async_trait;

use crate::model::article::{Article, ArticleId, Slug, UserId};

/// article_embedding_chunks 1 行分。webhook 側で PLaMO から取得した chunk と
/// embedding vector をまとめて渡す。
#[derive(Debug, Clone)]
pub struct ArticleEmbeddingChunk {
    pub chunk_index: u32,
    pub heading: Option<String>,
    pub content: String,
    pub token_count: u32,
    pub embedding: Vec<f32>,
}

/// Input data for creating or updating an article
#[derive(Debug, Clone)]
pub struct UpsertArticleInput {
    pub user_id: UserId,
    pub slug: Slug,
    pub title: String,
    pub content: String,
    /// 事前生成した変換済みHTML。Some なら保存し、None なら既存値を維持する
    pub content_html: Option<String>,
    pub description: Option<String>,
    pub thumbnail: Option<String>,
    pub should_publish: bool,
    /// フルパス表記のタグ（例: "rust", "aws/lambda"）。正規化は adapter 側で行う
    pub tags: Vec<String>,
}

/// Result of article upsert operation
#[derive(Debug, Clone)]
pub enum UpsertResult {
    Created(ArticleId),
    Updated(ArticleId),
    /// 記事本文は変更なしでタグのみ更新（articles.updated_at は変わらない）
    TagsUpdated(ArticleId),
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
    async fn upsert_article(
        &self,
        input: UpsertArticleInput,
    ) -> Result<UpsertResult, anyhow::Error>;

    /// article_id 単位で既存 chunk を全削除して新 chunk を差し替える。
    /// PLaMO で全 chunk の vector 生成に成功した後にだけ呼び出す想定。
    /// 失敗時は transaction が rollback され、既存 chunk が残る。
    async fn replace_article_chunks(
        &self,
        article_id: &ArticleId,
        chunks: &[ArticleEmbeddingChunk],
        chunking_version: &str,
        source_hash: &str,
    ) -> Result<(), anyhow::Error>;
}
