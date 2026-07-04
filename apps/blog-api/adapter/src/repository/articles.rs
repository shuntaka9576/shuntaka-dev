use async_trait::async_trait;
use chrono::{DateTime, Utc};
use derive_new::new;
use kernel::model::article::{
    Article, ArticleId, ArticleType, Content, ContentHtml, Description, Slug, Status, Thumbnail,
    Title, UserId, normalize_tags, parse_tag_path,
};
use kernel::repository::articles::{ArticlesRepository, UpsertArticleInput, UpsertResult};
use sqlx::FromRow;
use uuid::Uuid;

use crate::database::ConnectionPool;
use crate::observability::observe_query;

/// sync_tags 全体を 1 span で計装するための代表 SQL（statement_hash 用）
const TAGS_SYNC_SQL: &str =
    "DELETE FROM articles_tags; INSERT IGNORE INTO tags; INSERT IGNORE INTO articles_tags";

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

        // normalize_tags(書き込み時) と同じ sort 済み状態に揃えて差分比較を安定させる
        let mut tags: Vec<String> = row
            .tag_names
            .map(|s| s.split(',').map(str::to_string).collect())
            .unwrap_or_default();
        tags.sort();

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
            tags,
            row.published_at,
            row.created_at,
            row.updated_at,
        ))
    }
}

/// 記事のタグ関連を DELETE ALL + INSERT の冪等方式で同期する。
/// tags はパスの浅い方から順に INSERT IGNORE で存在を保証し（隣接リスト、最大3階層）、
/// articles_tags は leaf タグのみに張る。articles テーブルには触れないため
/// updated_at は変化しない。既存タグ名が別の親で登録済みの場合は
/// INSERT IGNORE により既存の親子関係が維持される（name はグローバル一意）。
async fn sync_tags(
    tx: &mut sqlx::Transaction<'_, sqlx::MySql>,
    article_id: &str,
    tags: &[String],
) -> Result<(), anyhow::Error> {
    sqlx::query("DELETE FROM articles_tags WHERE article_id = ?")
        .bind(article_id)
        .execute(&mut **tx)
        .await?;

    for tag in tags {
        let segments = parse_tag_path(tag).map_err(|e| anyhow::anyhow!(e))?;

        for (i, name) in segments.iter().enumerate() {
            if i == 0 {
                sqlx::query("INSERT IGNORE INTO tags (name) VALUES (?)")
                    .bind(name)
                    .execute(&mut **tx)
                    .await?;
            } else {
                sqlx::query(
                    "INSERT IGNORE INTO tags (name, parent_tag_id) \
                     SELECT ?, tag_id FROM tags WHERE name = ?",
                )
                .bind(name)
                .bind(&segments[i - 1])
                .execute(&mut **tx)
                .await?;
            }
        }

        let leaf = segments.last().expect("parse_tag_path returns non-empty");
        sqlx::query(
            "INSERT IGNORE INTO articles_tags (article_id, tag_id) \
             SELECT ?, tag_id FROM tags WHERE name = ?",
        )
        .bind(article_id)
        .bind(leaf)
        .execute(&mut **tx)
        .await?;
    }

    Ok(())
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
        // タグは再帰CTE（隣接リストをフルパスに展開）で取得。読み取りで得た
        // tags は upsert 時の差分比較（tags_changed）にも使う
        let sql = r#"
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
            WHERE a.user_id = ? AND a.slug = ?
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

        let normalized_tags = normalize_tags(&input.tags);
        // 階層の深さは DB で強制できないため、書き込み前にアプリ層で検証する
        for tag in &normalized_tags {
            parse_tag_path(tag).map_err(|e| anyhow::anyhow!(e))?;
        }

        match existing {
            Some(article) => {
                let content_changed = article.content.as_str() != input.content;
                let title_changed = article.title.as_str() != input.title;
                let type_changed = article
                    .article_type
                    .as_ref()
                    .map(|t| t.as_str() != input.article_type)
                    .unwrap_or(true);
                let thumbnail_changed =
                    article.thumbnail.as_ref().map(|t| t.as_str()) != input.thumbnail.as_deref();
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

                let article_changed = content_changed
                    || title_changed
                    || type_changed
                    || thumbnail_changed
                    || description_changed
                    || status_changed;
                let tags_changed = article.tags != normalized_tags;

                if !article_changed && !tags_changed {
                    return Ok(UpsertResult::NoChange(article.article_id));
                }

                let article_id_str = article.article_id.as_uuid().to_string();
                let mut tx = self.db.pool().begin().await?;

                if article_changed {
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
                            .bind(&article_id_str)
                            .execute(&mut *tx),
                        |res| Some(res.rows_affected() as i64),
                    )
                    .await?;
                }

                // タグのみの変更では articles を UPDATE しない（updated_at を変えない）
                if tags_changed {
                    observe_query(
                        "article_tags_sync",
                        TAGS_SYNC_SQL,
                        sync_tags(&mut tx, &article_id_str, &normalized_tags),
                        |_| None,
                    )
                    .await?;
                }

                tx.commit().await?;

                if article_changed {
                    Ok(UpsertResult::Updated(article.article_id))
                } else {
                    Ok(UpsertResult::TagsUpdated(article.article_id))
                }
            }
            None => {
                let article_id = Uuid::new_v4();
                let article_id_str = article_id.to_string();
                let now = Utc::now();
                let status = if input.should_publish {
                    "published"
                } else {
                    "draft"
                };
                let published_at = if input.should_publish {
                    Some(now)
                } else {
                    None
                };
                let description = input
                    .description
                    .as_ref()
                    .cloned()
                    .unwrap_or_else(|| input.title.clone());

                let mut tx = self.db.pool().begin().await?;

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
                        .bind(&article_id_str)
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
                        .execute(&mut *tx),
                    |res| Some(res.rows_affected() as i64),
                )
                .await?;

                if !normalized_tags.is_empty() {
                    observe_query(
                        "article_tags_sync",
                        TAGS_SYNC_SQL,
                        sync_tags(&mut tx, &article_id_str, &normalized_tags),
                        |_| None,
                    )
                    .await?;
                }

                tx.commit().await?;

                Ok(UpsertResult::Created(ArticleId::new(article_id)))
            }
        }
    }
}
