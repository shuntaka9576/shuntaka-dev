use async_trait::async_trait;
use chrono::{DateTime, Utc};
use derive_new::new;
use kernel::model::article::{
    Article, ArticleId, ArticleType, Content, Description, Slug, Status, Thumbnail, Title, UserId,
};
use kernel::repository::users_articles::UsersArticlesRepository;
use sqlx::FromRow;
use uuid::Uuid;

use crate::database::ConnectionPool;

#[derive(FromRow)]
struct ArticleRow {
    article_id: Uuid,
    title: String,
    slug: String,
    user_id: Uuid,
    content: String,
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
        let status =
            Status::new(row.status).map_err(|e| anyhow::anyhow!("Invalid status: {e}"))?;

        let article_type = row
            .article_type
            .map(ArticleType::new)
            .transpose()
            .map_err(|e| anyhow::anyhow!("Invalid article type: {e}"))?;

        Ok(Article::new(
            ArticleId::new(row.article_id),
            Title::new(row.title),
            Slug::new(row.slug),
            UserId::new(row.user_id),
            Content::new(row.content),
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
    ) -> Result<Vec<Article>, anyhow::Error> {
        let rows: Vec<ArticleRow> = sqlx::query_as(
            r#"
            SELECT
                a.article_id,
                a.title,
                a.slug,
                a.user_id,
                a.content,
                a.thumbnail,
                a.description,
                a.status,
                a.type,
                a.published_at,
                a.created_at,
                a.updated_at
            FROM app.articles a
            JOIN app.users u ON a.user_id = u.user_id
            WHERE a.status = 'published' AND a.type = $1 AND u.name = $2
            ORDER BY a.published_at DESC
            "#,
        )
        .bind(article_type.as_str())
        .bind(user_name)
        .fetch_all(self.db.inner_ref())
        .await?;

        rows.into_iter().map(Article::try_from).collect()
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
                a.thumbnail,
                a.description,
                a.status,
                a.type,
                a.published_at,
                a.created_at,
                a.updated_at
            FROM app.articles a
            JOIN app.users u ON a.user_id = u.user_id
            WHERE a.status = 'published' AND a.slug = $1 AND u.name = $2
            "#,
        )
        .bind(slug)
        .bind(user_name)
        .fetch_optional(self.db.inner_ref())
        .await?;

        row.map(Article::try_from).transpose()
    }
}
