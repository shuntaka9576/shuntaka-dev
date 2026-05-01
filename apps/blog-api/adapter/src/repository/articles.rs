use async_trait::async_trait;
use chrono::{DateTime, Utc};
use derive_new::new;
use kernel::model::article::{
    Article, ArticleId, ArticleType, Content, Description, Slug, Status, Thumbnail, Title, UserId,
};
use kernel::repository::articles::{ArticlesRepository, UpsertArticleInput, UpsertResult};
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
pub struct ArticlesRepositoryImpl {
    db: ConnectionPool,
}

#[async_trait]
impl ArticlesRepository for ArticlesRepositoryImpl {
    async fn find_by_user_id_and_slug(
        &self,
        user_id: &UserId,
        slug: &str,
    ) -> Result<Option<Article>, anyhow::Error> {
        let row: Option<ArticleRow> = sqlx::query_as(
            r#"
            SELECT
                article_id,
                title,
                slug,
                user_id,
                content,
                thumbnail,
                description,
                status,
                type,
                published_at,
                created_at,
                updated_at
            FROM app.articles
            WHERE user_id = $1 AND slug = $2
            "#,
        )
        .bind(user_id.as_uuid())
        .bind(slug)
        .fetch_optional(&self.db.pool())
        .await?;

        row.map(Article::try_from).transpose()
    }

    async fn upsert_article(
        &self,
        input: UpsertArticleInput,
    ) -> Result<UpsertResult, anyhow::Error> {
        // Check if article exists
        let existing = self
            .find_by_user_id_and_slug(&input.user_id, input.slug.as_str())
            .await?;

        match existing {
            Some(article) => {
                // Check if content changed
                let content_changed = article.content.as_str() != input.content;
                let title_changed = article.title.as_str() != input.title;
                let type_changed = article
                    .article_type
                    .as_ref()
                    .map(|t| t.as_str() != input.article_type)
                    .unwrap_or(true);
                let thumbnail_changed = article.thumbnail.as_ref().map(|t| t.as_str())
                    != input.thumbnail.as_deref();
                let description_changed = input
                    .description
                    .as_ref()
                    .map(|d| article.description.as_str() != d)
                    .unwrap_or(false);

                // Determine new status
                let new_status = if input.should_publish {
                    "published"
                } else {
                    "draft"
                };
                let status_changed = article.status.as_str() != new_status;

                if !content_changed
                    && !title_changed
                    && !type_changed
                    && !thumbnail_changed
                    && !description_changed
                    && !status_changed
                {
                    return Ok(UpsertResult::NoChange(article.article_id));
                }

                // Update article
                let now = Utc::now();
                let published_at = if input.should_publish && article.published_at.is_none() {
                    Some(now)
                } else {
                    article.published_at
                };

                let new_description = input
                    .description
                    .as_ref()
                    .cloned()
                    .unwrap_or_else(|| article.description.as_str().to_string());

                sqlx::query(
                    r#"
                    UPDATE app.articles
                    SET title = $1,
                        content = $2,
                        thumbnail = $3,
                        description = $4,
                        type = $5,
                        status = $6,
                        published_at = $7,
                        updated_at = $8
                    WHERE article_id = $9
                    "#,
                )
                .bind(&input.title)
                .bind(&input.content)
                .bind(&input.thumbnail)
                .bind(&new_description)
                .bind(&input.article_type)
                .bind(new_status)
                .bind(published_at)
                .bind(now)
                .bind(article.article_id.as_uuid())
                .execute(&self.db.pool())
                .await?;

                Ok(UpsertResult::Updated(article.article_id))
            }
            None => {
                // Create new article
                let article_id = Uuid::new_v4();
                let now = Utc::now();
                let status = if input.should_publish {
                    "published"
                } else {
                    "draft"
                };
                let published_at = if input.should_publish { Some(now) } else { None };
                let description = input
                    .description
                    .as_ref()
                    .cloned()
                    .unwrap_or_else(|| input.title.clone());

                sqlx::query(
                    r#"
                    INSERT INTO app.articles (
                        article_id,
                        user_id,
                        title,
                        slug,
                        content,
                        thumbnail,
                        description,
                        type,
                        status,
                        published_at,
                        created_at,
                        updated_at
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                    "#,
                )
                .bind(article_id)
                .bind(input.user_id.as_uuid())
                .bind(&input.title)
                .bind(input.slug.as_str())
                .bind(&input.content)
                .bind(&input.thumbnail)
                .bind(&description)
                .bind(&input.article_type)
                .bind(status)
                .bind(published_at)
                .bind(now)
                .bind(now)
                .execute(&self.db.pool())
                .await?;

                Ok(UpsertResult::Created(ArticleId::new(article_id)))
            }
        }
    }
}
