use async_trait::async_trait;
use chrono::{DateTime, Utc};
use derive_new::new;
use kernel::model::article::{
    Article, ArticleId, Content, ContentHtml, Description, Slug, Status, Thumbnail, Title, UserId,
    normalize_tags, parse_tag_path,
};
use kernel::repository::articles::{
    ArticleEmbeddingChunk, ArticlesRepository, UpsertArticleInput, UpsertResult,
};
use sqlx::FromRow;
use uuid::Uuid;

use crate::database::ConnectionPool;
use crate::observability::observe_query;

/// sync_tags 全体を 1 span で計装するための代表 SQL（statement_hash 用）
const TAGS_SYNC_SQL: &str =
    "DELETE FROM articles_tags; INSERT IGNORE INTO tags; INSERT IGNORE INTO articles_tags";

/// sync_tag_article_counts 全体を 1 span で計装するための代表 SQL（statement_hash 用）
const TAG_ARTICLE_COUNTS_SYNC_SQL: &str =
    "DELETE FROM tag_article_counts; INSERT INTO tag_article_counts";

/// replace_article_chunks 全体を 1 span で計装するための代表 SQL（statement_hash 用）
const CHUNKS_REPLACE_SQL: &str =
    "DELETE FROM article_embedding_chunks; INSERT INTO article_embedding_chunks";

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

/// user 単位の tag_article_counts を DELETE + INSERT で再計算する。
/// published 記事の articles_tags を祖先ロールアップして集計するため、
/// status 変化・tags 変化のいずれに対しても正しい結果になる。
/// トランザクション内で呼ぶことで、articles / articles_tags の変更と原子的に反映される。
///
/// `type` カラムは廃止済みの概念だが、既存スキーマの PK (user_id, type, tag_id) が
/// NOT NULL のため定数 'all' を入れる。読み取り側は type を横断して SUM するので、
/// 旧 per-type 行が残っていても user 単位の DELETE で置き換わり整合する。
/// カラム自体の削除はスキーマクリーンアップ時に行う。
async fn sync_tag_article_counts(
    tx: &mut sqlx::Transaction<'_, sqlx::MySql>,
    user_id: &str,
) -> Result<(), anyhow::Error> {
    // 対象 user の既存集計を削除する（旧 per-type 行も含めて全て）
    sqlx::query("DELETE FROM tag_article_counts WHERE user_id = ?")
        .bind(user_id)
        .execute(&mut **tx)
        .await?;

    // published 記事 × leaf タグ × 祖先ロールアップで再集計して INSERT する
    let insert_sql = r#"INSERT INTO tag_article_counts (user_id, `type`, tag_id, article_count)
WITH RECURSIVE tag_ancestors AS (
    SELECT tag_id AS leaf_tag_id, tag_id AS anc_tag_id FROM tags
    UNION ALL
    SELECT ta.leaf_tag_id, t.parent_tag_id AS anc_tag_id
    FROM tag_ancestors ta
    JOIN tags t ON t.tag_id = ta.anc_tag_id
    WHERE t.parent_tag_id IS NOT NULL
)
SELECT a.user_id, 'all', ta.anc_tag_id, COUNT(DISTINCT ats.article_id)
FROM articles a
JOIN articles_tags ats ON ats.article_id = a.article_id
JOIN tag_ancestors ta ON ta.leaf_tag_id = ats.tag_id
WHERE a.user_id = ? AND a.status = 'published'
GROUP BY a.user_id, ta.anc_tag_id"#;

    sqlx::query(insert_sql)
        .bind(user_id)
        .execute(&mut **tx)
        .await?;

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
                    || thumbnail_changed
                    || description_changed
                    || status_changed;
                let tags_changed = article.tags != normalized_tags;

                if !article_changed && !tags_changed {
                    return Ok(UpsertResult::NoChange(article.article_id));
                }

                let article_id_str = article.article_id.as_uuid().to_string();
                let user_id_str = input.user_id.as_uuid().to_string();

                // tag_article_counts の再計算が必要な条件:
                //   status 変化（published ↔ draft）→ カウント対象の増減
                //   tags 変化 → 集計値の増減
                let counts_affected = status_changed || tags_changed;

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

                // status / tags の変化がある場合、user 単位の集計を再計算する
                if counts_affected {
                    observe_query(
                        "tag_article_counts_sync",
                        TAG_ARTICLE_COUNTS_SYNC_SQL,
                        sync_tag_article_counts(&mut tx, &user_id_str),
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
                let user_id_str = input.user_id.as_uuid().to_string();
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
                        status,
                        published_at,
                        created_at,
                        updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    "#;
                observe_query(
                    "article_insert",
                    sql,
                    sqlx::query(sql)
                        .bind(&article_id_str)
                        .bind(&user_id_str)
                        .bind(&input.title)
                        .bind(input.slug.as_str())
                        .bind(&input.content)
                        .bind(&input.content_html)
                        .bind(&input.thumbnail)
                        .bind(&description)
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

                // 新規記事の tag_article_counts を再計算する（draft でも冪等なので常に実行）
                observe_query(
                    "tag_article_counts_sync",
                    TAG_ARTICLE_COUNTS_SYNC_SQL,
                    sync_tag_article_counts(&mut tx, &user_id_str),
                    |_| None,
                )
                .await?;

                tx.commit().await?;

                Ok(UpsertResult::Created(ArticleId::new(article_id)))
            }
        }
    }

    async fn replace_article_chunks(
        &self,
        article_id: &ArticleId,
        chunks: &[ArticleEmbeddingChunk],
        chunking_version: &str,
        source_hash: &str,
    ) -> Result<(), anyhow::Error> {
        let article_id_str = article_id.as_uuid().to_string();

        observe_query(
            "article_chunks_replace",
            CHUNKS_REPLACE_SQL,
            async {
                let mut tx = self.db.pool().begin().await?;

                sqlx::query("DELETE FROM article_embedding_chunks WHERE article_id = ?")
                    .bind(&article_id_str)
                    .execute(&mut *tx)
                    .await?;

                for chunk in chunks {
                    // TiDB の VECTOR 列は JSON 配列文字列を受け付ける。
                    // tidb-embedder と同じ形式で送るため serde_json で serialize する。
                    let embedding_json = serde_json::to_string(&chunk.embedding)?;
                    sqlx::query(
                        r#"
                        INSERT INTO article_embedding_chunks
                            (article_id, chunk_index, heading, content, token_count,
                             chunking_version, source_hash, embedding)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        "#,
                    )
                    .bind(&article_id_str)
                    .bind(chunk.chunk_index)
                    .bind(chunk.heading.as_deref())
                    .bind(&chunk.content)
                    .bind(chunk.token_count)
                    .bind(chunking_version)
                    .bind(source_hash)
                    .bind(&embedding_json)
                    .execute(&mut *tx)
                    .await?;
                }

                tx.commit().await?;
                Ok::<(), anyhow::Error>(())
            },
            |_| Some(chunks.len() as i64),
        )
        .await
    }
}
