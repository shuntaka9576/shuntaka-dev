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
    /// GROUP_CONCAT したフルパス表記のタグ（カンマ区切り）。タグなしは NULL
    tag_names: Option<String>,
    published_at: Option<DateTime<Utc>>,
    created_at: Option<DateTime<Utc>>,
    updated_at: Option<DateTime<Utc>>,
}

fn parse_tag_names(tag_names: Option<String>) -> Vec<String> {
    let mut tags: Vec<String> = tag_names
        .map(|s| s.split(',').map(str::to_string).collect())
        .unwrap_or_default();
    tags.sort();
    tags
}

impl TryFrom<ArticleRow> for Article {
    type Error = anyhow::Error;

    fn try_from(row: ArticleRow) -> Result<Self, Self::Error> {
        let article_id = Uuid::parse_str(&row.article_id)
            .map_err(|e| anyhow::anyhow!("Invalid article_id UUID: {e}"))?;
        let user_id = Uuid::parse_str(&row.user_id)
            .map_err(|e| anyhow::anyhow!("Invalid user_id UUID: {e}"))?;

        let status = Status::new(row.status).map_err(|e| anyhow::anyhow!("Invalid status: {e}"))?;

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
            parse_tag_names(row.tag_names),
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
    /// GROUP_CONCAT したフルパス表記のタグ（カンマ区切り）。タグなしは NULL
    tag_names: Option<String>,
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

        let status = Status::new(row.status).map_err(|e| anyhow::anyhow!("Invalid status: {e}"))?;

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
            parse_tag_names(row.tag_names),
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

        // タグは再帰CTE（ナイーブツリーの隣接リストをフルパスに展開）+ 相関サブクエリ
        // 1列で取得する（追加ラウンドトリップなし）。WITH 句が付いても USE_INDEX
        // ヒントが効くことは EXPLAIN で確認済み
        let list_sql = r#"
            WITH RECURSIVE tag_paths AS (
                SELECT tag_id, name AS path
                FROM tags
                WHERE parent_tag_id IS NULL
                UNION ALL
                SELECT t.tag_id, CONCAT(tp.path, '/', t.name)
                FROM tags t
                JOIN tag_paths tp ON t.parent_tag_id = tp.tag_id
            )
            SELECT /*+ USE_INDEX(a, idx_articles_user_status_type_published_at_id) */
                a.article_id,
                a.title,
                a.slug,
                a.user_id,
                a.thumbnail,
                a.description,
                a.status,
                a.`type`,
                (SELECT GROUP_CONCAT(tp.path SEPARATOR ',')
                 FROM articles_tags at2
                 JOIN tag_paths tp ON at2.tag_id = tp.tag_id
                 WHERE at2.article_id = a.article_id) AS tag_names,
                a.published_at,
                a.created_at,
                a.updated_at
            FROM articles a
            WHERE a.user_id = (SELECT user_id FROM users WHERE name = ?)
              AND a.status = 'published'
              AND a.`type` = ?
            ORDER BY a.published_at DESC, a.article_id DESC
            LIMIT ? OFFSET ?
            "#;
        let rows_future = observe_query(
            "article_list",
            list_sql,
            sqlx::query_as::<_, ArticleSummaryRow>(list_sql)
                .bind(user_name)
                .bind(article_type.as_str())
                .bind(limit)
                .bind(offset)
                .fetch_all(&pool),
            |rows| Some(rows.len() as i64),
        );

        let count_sql = r#"
            SELECT COUNT(*)
            FROM articles a
            WHERE a.user_id = (SELECT user_id FROM users WHERE name = ?)
              AND a.status = 'published'
              AND a.`type` = ?
            "#;
        let count_future = observe_query(
            "article_list_count",
            count_sql,
            sqlx::query_as::<_, (i64,)>(count_sql)
                .bind(user_name)
                .bind(article_type.as_str())
                .fetch_one(&pool),
            |_| Some(1),
        );

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
        let detail_sql = r#"
            WITH RECURSIVE tag_paths AS (
                SELECT tag_id, name AS path
                FROM tags
                WHERE parent_tag_id IS NULL
                UNION ALL
                SELECT t.tag_id, CONCAT(tp.path, '/', t.name)
                FROM tags t
                JOIN tag_paths tp ON t.parent_tag_id = tp.tag_id
            )
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
                (SELECT GROUP_CONCAT(tp.path SEPARATOR ',')
                 FROM articles_tags at2
                 JOIN tag_paths tp ON at2.tag_id = tp.tag_id
                 WHERE at2.article_id = a.article_id) AS tag_names,
                a.published_at,
                a.created_at,
                a.updated_at
            FROM articles a
            JOIN users u ON a.user_id = u.user_id
            WHERE a.status = 'published' AND a.slug = ? AND u.name = ?
            "#;
        let row: Option<ArticleRow> = observe_query(
            "article_detail",
            detail_sql,
            sqlx::query_as(detail_sql)
                .bind(slug)
                .bind(user_name)
                .fetch_optional(&self.db.pool()),
            |row| Some(i64::from(row.is_some())),
        )
        .await?;

        row.map(Article::try_from).transpose()
    }
}
