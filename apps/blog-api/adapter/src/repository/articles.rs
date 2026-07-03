use async_trait::async_trait;
use chrono::{DateTime, Utc};
use derive_new::new;
use kernel::model::article::{
    Article, ArticleId, ArticleType, Content, ContentHtml, Description, Slug, Status, Thumbnail,
    Title, UserId,
};
use kernel::repository::articles::{ArticlesRepository, UpsertArticleInput, UpsertResult};
use sqlx::FromRow;
use uuid::Uuid;

use crate::database::ConnectionPool;
use crate::observability::observe_query;

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
        let sql = r#"
            SELECT
                article_id,
                title,
                slug,
                user_id,
                content,
                content_html,
                thumbnail,
                description,
                status,
                `type`,
                published_at,
                created_at,
                updated_at
            FROM articles
            WHERE user_id = ? AND slug = ?
            "#;
        let row: Option<ArticleRow> = observe_query(
            "article_by_user_and_slug",
            sql,
            sqlx::query_as(sql)
                .bind(user_id.as_uuid().to_string())
                .bind(slug)
                .fetch_optional(&self.db.pool()),
            |row| Some(i64::from(row.is_some())),
        )
        .await?;

        row.map(Article::try_from).transpose()
    }

    async fn upsert_article(
        &self,
        input: UpsertArticleInput,
    ) -> Result<UpsertResult, anyhow::Error> {
        let existing = self
            .find_by_user_id_and_slug(&input.user_id, input.slug.as_str())
            .await?;

        match existing {
            Some(article) => {
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

                let sql = r#"
                    UPDATE articles
                    SET title = ?,
                        content = ?,
                        content_html = COALESCE(?, content_html),
                        thumbnail = ?,
                        description = ?,
                        `type` = ?,
                        status = ?,
                        published_at = ?,
                        updated_at = ?
                    WHERE article_id = ?
                    "#;
                observe_query(
                    "article_update",
                    sql,
                    sqlx::query(sql)
                        .bind(&input.title)
                        .bind(&input.content)
                        .bind(&input.content_html)
                        .bind(&input.thumbnail)
                        .bind(&new_description)
                        .bind(&input.article_type)
                        .bind(new_status)
                        .bind(published_at)
                        .bind(now)
                        .bind(article.article_id.as_uuid().to_string())
                        .execute(&self.db.pool()),
                    |res| Some(res.rows_affected() as i64),
                )
                .await?;

                Ok(UpsertResult::Updated(article.article_id))
            }
            None => {
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

                let sql = r#"
                    INSERT INTO articles (
                        article_id,
                        user_id,
                        title,
                        slug,
                        content,
                        content_html,
                        thumbnail,
                        description,
                        `type`,
                        status,
                        published_at,
                        created_at,
                        updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    "#;
                observe_query(
                    "article_insert",
                    sql,
                    sqlx::query(sql)
                        .bind(article_id.to_string())
                        .bind(input.user_id.as_uuid().to_string())
                        .bind(&input.title)
                        .bind(input.slug.as_str())
                        .bind(&input.content)
                        .bind(&input.content_html)
                        .bind(&input.thumbnail)
                        .bind(&description)
                        .bind(&input.article_type)
                        .bind(status)
                        .bind(published_at)
                        .bind(now)
                        .bind(now)
                        .execute(&self.db.pool()),
                    |res| Some(res.rows_affected() as i64),
                )
                .await?;

                Ok(UpsertResult::Created(ArticleId::new(article_id)))
            }
        }
    }
}
