use async_trait::async_trait;
use chrono::{DateTime, Utc};
use derive_new::new;
use kernel::model::article::{
    Article, ArticleId, ArticleSummary, ArticleType, Content, ContentHtml, Description, Slug,
    Status, Thumbnail, Title, UserId,
};
use kernel::repository::users_articles::{ArticleSummaryPage, UsersArticlesRepository};
use sqlx::FromRow;
use uuid::Uuid;

use crate::database::ConnectionPool;

#[derive(FromRow)]
struct ArticleRow {
    article_id: String,
    title: String,
    slug: String,
    user_id: String,
    content: String,
    content_html: Option<String>,
    thumbnail: Option<String>,
    description: String,
    status: String,
    #[sqlx(rename = "type")]
    article_type: Option<String>,
    published_at: Option<DateTime<Utc>>,
    created_at: Option<DateTime<Utc>>,
    updated_at: Option<DateTime<Utc>>,
}

impl TryFrom<ArticleRow> for Article {
    type Error = anyhow::Error;

    fn try_from(row: ArticleRow) -> Result<Self, Self::Error> {
        let article_id = Uuid::parse_str(&row.article_id)
            .map_err(|e| anyhow::anyhow!("Invalid article_id UUID: {e}"))?;
        let user_id = Uuid::parse_str(&row.user_id)
            .map_err(|e| anyhow::anyhow!("Invalid user_id UUID: {e}"))?;

        let status =
            Status::new(row.status).map_err(|e| anyhow::anyhow!("Invalid status: {e}"))?;

        let article_type = row
            .article_type
            .map(ArticleType::new)
            .transpose()
            .map_err(|e| anyhow::anyhow!("Invalid article type: {e}"))?;

        Ok(Article::new(
            ArticleId::new(article_id),
            Title::new(row.title),
            Slug::new(row.slug),
            UserId::new(user_id),
            Content::new(row.content),
            row.content_html.map(ContentHtml::new),
            row.thumbnail.map(Thumbnail::new),
            Description::new(row.description),
            status,
            article_type,
            row.published_at,
            row.created_at,
            row.updated_at,
        ))
    }
}

#[derive(FromRow)]
struct ArticleSummaryRow {
    article_id: String,
    title: String,
    slug: String,
    user_id: String,
    thumbnail: Option<String>,
    description: String,
    status: String,
    #[sqlx(rename = "type")]
    article_type: Option<String>,
    published_at: Option<DateTime<Utc>>,
    created_at: Option<DateTime<Utc>>,
    updated_at: Option<DateTime<Utc>>,
}

impl TryFrom<ArticleSummaryRow> for ArticleSummary {
    type Error = anyhow::Error;

    fn try_from(row: ArticleSummaryRow) -> Result<Self, Self::Error> {
        let article_id = Uuid::parse_str(&row.article_id)
            .map_err(|e| anyhow::anyhow!("Invalid article_id UUID: {e}"))?;
        let user_id = Uuid::parse_str(&row.user_id)
            .map_err(|e| anyhow::anyhow!("Invalid user_id UUID: {e}"))?;

        let status =
            Status::new(row.status).map_err(|e| anyhow::anyhow!("Invalid status: {e}"))?;

        let article_type = row
            .article_type
            .map(ArticleType::new)
            .transpose()
            .map_err(|e| anyhow::anyhow!("Invalid article type: {e}"))?;

        Ok(ArticleSummary::new(
            ArticleId::new(article_id),
            Title::new(row.title),
            Slug::new(row.slug),
            UserId::new(user_id),
            row.thumbnail.map(Thumbnail::new),
            Description::new(row.description),
            status,
            article_type,
            row.published_at,
            row.created_at,
            row.updated_at,
        ))
    }
}

#[derive(new)]
pub struct UsersArticlesRepositoryImpl {
    db: ConnectionPool,
}

#[async_trait]
impl UsersArticlesRepository for UsersArticlesRepositoryImpl {
    async fn find_published_by_user_name_and_type(
        &self,
        user_name: &str,
        article_type: &ArticleType,
        offset: u64,
        limit: u64,
    ) -> Result<ArticleSummaryPage, anyhow::Error> {
        let pool = self.db.pool();

        let rows_future = sqlx::query_as::<_, ArticleSummaryRow>(
            r#"
            SELECT /*+ USE_INDEX(a, idx_articles_user_status_type_published_at_id) */
                a.article_id,
                a.title,
                a.slug,
                a.user_id,
                a.thumbnail,
                a.description,
                a.status,
                a.`type`,
                a.published_at,
                a.created_at,
                a.updated_at
            FROM articles a
            WHERE a.user_id = (SELECT user_id FROM users WHERE name = ?)
              AND a.status = 'published'
              AND a.`type` = ?
            ORDER BY a.published_at DESC, a.article_id DESC
            LIMIT ? OFFSET ?
            "#,
        )
        .bind(user_name)
        .bind(article_type.as_str())
        .bind(limit)
        .bind(offset)
        .fetch_all(&pool);

        let count_future = sqlx::query_as::<_, (i64,)>(
            r#"
            SELECT COUNT(*)
            FROM articles a
            WHERE a.user_id = (SELECT user_id FROM users WHERE name = ?)
              AND a.status = 'published'
              AND a.`type` = ?
            "#,
        )
        .bind(user_name)
        .bind(article_type.as_str())
        .fetch_one(&pool);

        // DB が Tailscale 越しで RTT が大きいため、一覧と件数を並列に投げる
        let (rows, total_count) = tokio::try_join!(rows_future, count_future)?;

        let articles: Vec<ArticleSummary> = rows
            .into_iter()
            .map(ArticleSummary::try_from)
            .collect::<Result<_, _>>()?;

        Ok(ArticleSummaryPage {
            articles,
            total_count: total_count.0 as u64,
        })
    }

    async fn find_published_by_user_name_and_slug(
        &self,
        user_name: &str,
        slug: &str,
    ) -> Result<Option<Article>, anyhow::Error> {
        let row: Option<ArticleRow> = sqlx::query_as(
            r#"
            SELECT
                a.article_id,
                a.title,
                a.slug,
                a.user_id,
                a.content,
                a.content_html,
                a.thumbnail,
                a.description,
                a.status,
                a.`type`,
                a.published_at,
                a.created_at,
                a.updated_at
            FROM articles a
            JOIN users u ON a.user_id = u.user_id
            WHERE a.status = 'published' AND a.slug = ? AND u.name = ?
            "#,
        )
        .bind(slug)
        .bind(user_name)
        .fetch_optional(&self.db.pool())
        .await?;

        row.map(Article::try_from).transpose()
    }
}
