use std::collections::HashMap;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use derive_new::new;
use kernel::model::article::{
    Article, ArticleId, ArticleSummary, Content, ContentHtml, Description, Slug, Status, TagFilter,
    TagFilterMode, Thumbnail, Title, UserId,
};
use kernel::repository::users_articles::{
    ArticleSearchResult, ArticleSearchResultPage, ArticleSummaryPage, TagFacet, TagFacetsResult,
    UsersArticlesRepository,
};
use sqlx::{FromRow, MySqlPool};
use uuid::Uuid;

use crate::database::ConnectionPool;
use crate::observability::observe_query;

// ─────────────────────────────────────────
// Row types
// ─────────────────────────────────────────

/// 一覧取得（2クエリ方式）用の行。タグは別クエリで取得する。
#[derive(FromRow)]
struct ArticleSummaryBaseRow {
    article_id: String,
    title: String,
    slug: String,
    user_id: String,
    thumbnail: Option<String>,
    description: String,
    status: String,
    published_at: Option<DateTime<Utc>>,
    created_at: Option<DateTime<Utc>>,
    updated_at: Option<DateTime<Utc>>,
}

impl TryFrom<ArticleSummaryBaseRow> for ArticleSummary {
    type Error = anyhow::Error;

    fn try_from(row: ArticleSummaryBaseRow) -> Result<Self, Self::Error> {
        let article_id = Uuid::parse_str(&row.article_id)
            .map_err(|e| anyhow::anyhow!("Invalid article_id UUID: {e}"))?;
        let user_id = Uuid::parse_str(&row.user_id)
            .map_err(|e| anyhow::anyhow!("Invalid user_id UUID: {e}"))?;
        let status = Status::new(row.status).map_err(|e| anyhow::anyhow!("Invalid status: {e}"))?;

        Ok(ArticleSummary::new(
            ArticleId::new(article_id),
            Title::new(row.title),
            Slug::new(row.slug),
            UserId::new(user_id),
            row.thumbnail.map(Thumbnail::new),
            Description::new(row.description),
            status,
            Vec::new(), // タグは後からマージする
            row.published_at,
            row.created_at,
            row.updated_at,
        ))
    }
}

#[derive(FromRow)]
struct ArticleSearchRow {
    article_id: String,
    title: String,
    slug: String,
    user_id: String,
    thumbnail: Option<String>,
    description: String,
    status: String,
    published_at: Option<DateTime<Utc>>,
    created_at: Option<DateTime<Utc>>,
    updated_at: Option<DateTime<Utc>>,
    distance: f64,
    total_count: i64,
}

impl TryFrom<ArticleSearchRow> for ArticleSearchResult {
    type Error = anyhow::Error;

    fn try_from(row: ArticleSearchRow) -> Result<Self, Self::Error> {
        let distance = row.distance;
        let article = ArticleSummary::try_from(ArticleSummaryBaseRow {
            article_id: row.article_id,
            title: row.title,
            slug: row.slug,
            user_id: row.user_id,
            thumbnail: row.thumbnail,
            description: row.description,
            status: row.status,
            published_at: row.published_at,
            created_at: row.created_at,
            updated_at: row.updated_at,
        })?;
        Ok(Self { article, distance })
    }
}

/// タグ取得クエリ用の行
#[derive(FromRow)]
struct ArticleTagsRow {
    article_id: String,
    tag_names: String,
}

/// 詳細取得用の行（タグは相関サブクエリで1行にまとめる）
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
            parse_tag_names(row.tag_names),
            row.published_at,
            row.created_at,
            row.updated_at,
        ))
    }
}

// ─────────────────────────────────────────
// SQL building helpers
// ─────────────────────────────────────────

/// パスの末尾セグメント（leaf 名）を返す。"aws/lambda" → "lambda"
fn leaf_of_path(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// タグパスのリストから leaf 名で tag_id を解決する。
/// 返り値は paths と同じ順序で、該当タグが DB に存在しない場合は None。
async fn resolve_tag_ids_for_paths(
    pool: &MySqlPool,
    paths: &[String],
) -> Result<Vec<Option<String>>, anyhow::Error> {
    if paths.is_empty() {
        return Ok(vec![]);
    }
    let leaves: Vec<&str> = paths.iter().map(|p| leaf_of_path(p)).collect();
    let placeholders = leaves.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
    let sql = format!("SELECT tag_id, name FROM tags WHERE name IN ({placeholders})");
    let mut q = sqlx::query_as::<_, (String, String)>(sqlx::AssertSqlSafe(sql.as_str()));
    for leaf in &leaves {
        q = q.bind(*leaf);
    }
    let rows: Vec<(String, String)> = q.fetch_all(pool).await?;
    let name_to_id: HashMap<String, String> =
        rows.into_iter().map(|(id, name)| (name, id)).collect();
    let result = leaves
        .iter()
        .map(|leaf| name_to_id.get(*leaf).cloned())
        .collect();
    Ok(result)
}

/// ページ内の記事 ID リストに対するタグを取得し、article_id → タグリストのマップを返す。
async fn fetch_article_tags(
    pool: &MySqlPool,
    article_ids: &[String],
) -> Result<HashMap<String, Vec<String>>, anyhow::Error> {
    if article_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let placeholders = article_ids
        .iter()
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        r#"WITH RECURSIVE tag_paths AS (
    SELECT tag_id, name AS path FROM tags WHERE parent_tag_id IS NULL
    UNION ALL
    SELECT t.tag_id, CONCAT(tp.path, '/', t.name) FROM tags t
    JOIN tag_paths tp ON t.parent_tag_id = tp.tag_id
)
SELECT at2.article_id, GROUP_CONCAT(tp.path ORDER BY tp.path SEPARATOR ',') AS tag_names
FROM articles_tags at2
JOIN tag_paths tp ON at2.tag_id = tp.tag_id
WHERE at2.article_id IN ({placeholders})
GROUP BY at2.article_id"#
    );
    let mut q = sqlx::query_as::<_, ArticleTagsRow>(sqlx::AssertSqlSafe(sql.as_str()));
    for id in article_ids {
        q = q.bind(id.as_str());
    }
    let rows: Vec<ArticleTagsRow> = q.fetch_all(pool).await?;
    let mut map: HashMap<String, Vec<String>> = HashMap::new();
    for row in rows {
        let mut tags: Vec<String> = row.tag_names.split(',').map(str::to_string).collect();
        tags.sort();
        map.insert(row.article_id, tags);
    }
    Ok(map)
}

/// タグフィルタ用の WITH RECURSIVE CTE 本体と WHERE 条件句を構築する。
///
/// AND モード: 各タグ ID ごとに EXISTS 条件を生成して AND 連結する。
/// OR モード:  全タグ ID の子孫をまとめた単一 EXISTS 条件を生成する。
///
/// 返り値: (cte_sql_body, where_conditions)
///   AND: バインド順 → CTE 用 [tag_ids...], user_name, EXISTS 用 [tag_ids...]
///   OR:  バインド順 → CTE 用 [tag_ids...], user_name
fn build_list_filter_parts(tag_ids: &[String], mode: &TagFilterMode) -> (String, String) {
    let cte_in = (0..tag_ids.len())
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(", ");
    let cte = match mode {
        TagFilterMode::And => format!(
            "WITH RECURSIVE tag_descendants AS (\n    \
             SELECT tag_id, tag_id AS root_tag_id FROM tags WHERE tag_id IN ({cte_in})\n    \
             UNION ALL\n    \
             SELECT t.tag_id, td.root_tag_id FROM tags t \
             JOIN tag_descendants td ON t.parent_tag_id = td.tag_id\n)"
        ),
        TagFilterMode::Or => format!(
            "WITH RECURSIVE tag_descendants AS (\n    \
             SELECT tag_id FROM tags WHERE tag_id IN ({cte_in})\n    \
             UNION ALL\n    \
             SELECT t.tag_id FROM tags t \
             JOIN tag_descendants td ON t.parent_tag_id = td.tag_id\n)"
        ),
    };
    let conditions = match mode {
        TagFilterMode::And => (0..tag_ids.len())
            .map(|i| {
                format!(
                    "  AND EXISTS (\
                     SELECT 1 FROM articles_tags at{i} \
                     JOIN tag_descendants td ON at{i}.tag_id = td.tag_id AND td.root_tag_id = ? \
                     WHERE at{i}.article_id = a.article_id)"
                )
            })
            .collect::<Vec<_>>()
            .join("\n"),
        TagFilterMode::Or => "  AND EXISTS (\
                     SELECT 1 FROM articles_tags ats \
                     JOIN tag_descendants td ON ats.tag_id = td.tag_id \
                     WHERE ats.article_id = a.article_id)"
            .to_string(),
    };
    (cte, conditions)
}

/// ANN候補取得を必ず先に行い、公開条件・ユーザー・タグを外側でpost-filterするSQLを組み立てる。
fn build_search_sql(tag_ids: Option<&[String]>, mode: Option<&TagFilterMode>) -> String {
    let (with_prefix, filter_conditions) = match tag_ids {
        None => ("WITH ".to_string(), String::new()),
        Some(ids) => {
            let (filter_cte, conditions) =
                build_list_filter_parts(ids, mode.expect("tag filter mode must exist"));
            (format!("{filter_cte},\n"), format!("\n{conditions}"))
        }
    };

    format!(
        r#"{with_prefix}nearest_chunks AS (
    SELECT /*+ READ_FROM_STORAGE(TIFLASH[c]) */
           c.article_id,
           VEC_COSINE_DISTANCE(c.embedding, ?) AS distance
      FROM article_embedding_chunks AS c
     ORDER BY VEC_COSINE_DISTANCE(c.embedding, ?)
     LIMIT ?
),
ranked_articles AS (
    SELECT a.article_id, a.title, a.slug, a.user_id, a.thumbnail, a.description,
           a.status, a.published_at, a.created_at, a.updated_at, nc.distance,
           ROW_NUMBER() OVER (
               PARTITION BY a.article_id ORDER BY nc.distance, a.article_id
           ) AS chunk_rank
      FROM nearest_chunks AS nc
      JOIN articles AS a ON a.article_id = nc.article_id
      JOIN users AS u ON u.user_id = a.user_id
     WHERE a.status = 'published' AND u.name = ?{filter_conditions}
)
SELECT article_id, title, slug, user_id, thumbnail, description, status,
       published_at, created_at, updated_at, distance,
       COUNT(*) OVER() AS total_count
  FROM ranked_articles
 WHERE chunk_rank = 1
 ORDER BY distance, article_id
 LIMIT ? OFFSET ?"#
    )
}

/// ファセット集計クエリ用の tag_descendants CTE 本体と WHERE 条件句を構築する。
/// ファセットクエリでは、一覧クエリと別エイリアス (ft0, ft1..., fts) を使う。
fn build_facets_filter_parts(tag_ids: &[String], mode: &TagFilterMode) -> (String, String) {
    let cte_in = (0..tag_ids.len())
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(", ");
    let cte_body = match mode {
        TagFilterMode::And => format!(
            "tag_descendants AS (\n    \
             SELECT tag_id, tag_id AS root_tag_id FROM tags WHERE tag_id IN ({cte_in})\n    \
             UNION ALL\n    \
             SELECT t.tag_id, td.root_tag_id FROM tags t \
             JOIN tag_descendants td ON t.parent_tag_id = td.tag_id\n)"
        ),
        TagFilterMode::Or => format!(
            "tag_descendants AS (\n    \
             SELECT tag_id FROM tags WHERE tag_id IN ({cte_in})\n    \
             UNION ALL\n    \
             SELECT t.tag_id FROM tags t \
             JOIN tag_descendants td ON t.parent_tag_id = td.tag_id\n)"
        ),
    };
    let conditions = match mode {
        TagFilterMode::And => (0..tag_ids.len())
            .map(|i| {
                format!(
                    "  AND EXISTS (\
                     SELECT 1 FROM articles_tags ft{i} \
                     JOIN tag_descendants td ON ft{i}.tag_id = td.tag_id AND td.root_tag_id = ? \
                     WHERE ft{i}.article_id = a.article_id)"
                )
            })
            .collect::<Vec<_>>()
            .join("\n"),
        TagFilterMode::Or => "  AND EXISTS (\
                     SELECT 1 FROM articles_tags fts \
                     JOIN tag_descendants td ON fts.tag_id = td.tag_id \
                     WHERE fts.article_id = a.article_id)"
            .to_string(),
    };
    (cte_body, conditions)
}

// ─────────────────────────────────────────
// Repository implementation
// ─────────────────────────────────────────

#[derive(new)]
pub struct UsersArticlesRepositoryImpl {
    db: ConnectionPool,
}

#[async_trait]
impl UsersArticlesRepository for UsersArticlesRepositoryImpl {
    async fn find_published_by_user_name(
        &self,
        user_name: &str,
        tag_filter: Option<&TagFilter>,
        offset: u64,
        limit: u64,
    ) -> Result<ArticleSummaryPage, anyhow::Error> {
        let pool = self.db.pool();

        // タグフィルタが指定されている場合は leaf 名で tag_id を解決する
        let resolved_ids: Option<Vec<String>> = match tag_filter {
            None => None,
            Some(f) if f.is_empty() => None,
            Some(f) => {
                let resolved = resolve_tag_ids_for_paths(&pool, &f.paths).await?;
                match f.mode {
                    TagFilterMode::And => {
                        // AND モード: 1つでも未知のタグがあれば即座に空を返す
                        if resolved.iter().any(|r| r.is_none()) {
                            return Ok(ArticleSummaryPage {
                                articles: vec![],
                                total_count: 0,
                            });
                        }
                        Some(resolved.into_iter().flatten().collect())
                    }
                    TagFilterMode::Or => {
                        // OR モード: 未知のタグは除外する。全て未知なら空を返す
                        let ids: Vec<String> = resolved.into_iter().flatten().collect();
                        if ids.is_empty() {
                            return Ok(ArticleSummaryPage {
                                articles: vec![],
                                total_count: 0,
                            });
                        }
                        Some(ids)
                    }
                }
            }
        };

        let filter_mode: Option<&TagFilterMode> = tag_filter.map(|f| &f.mode);

        // SQL を構築する
        let (list_sql, count_sql) = match &resolved_ids {
            None => {
                let list = "SELECT /*+ USE_INDEX(a, idx_articles_user_status_type_published_at_id) */\n    \
                             a.article_id, a.title, a.slug, a.user_id, a.thumbnail, a.description,\n    \
                             a.status, a.published_at, a.created_at, a.updated_at\n\
                             FROM articles a\n\
                             WHERE a.user_id = (SELECT user_id FROM users WHERE name = ?)\n  \
                             AND a.status = 'published'\n\
                             ORDER BY a.published_at DESC, a.article_id DESC\n\
                             LIMIT ? OFFSET ?"
                    .to_string();
                let count = "SELECT COUNT(*)\n\
                              FROM articles a\n\
                              WHERE a.user_id = (SELECT user_id FROM users WHERE name = ?)\n  \
                              AND a.status = 'published'"
                    .to_string();
                (list, count)
            }
            Some(ids) => {
                let mode = filter_mode.unwrap();
                let (cte, conds) = build_list_filter_parts(ids, mode);
                let list = format!(
                    "{cte}\n\
                     SELECT /*+ USE_INDEX(a, idx_articles_user_status_type_published_at_id) */\n    \
                     a.article_id, a.title, a.slug, a.user_id, a.thumbnail, a.description,\n    \
                     a.status, a.published_at, a.created_at, a.updated_at\n\
                     FROM articles a\n\
                     WHERE a.user_id = (SELECT user_id FROM users WHERE name = ?)\n  \
                     AND a.status = 'published'\n\
                     {conds}\n\
                     ORDER BY a.published_at DESC, a.article_id DESC\n\
                     LIMIT ? OFFSET ?"
                );
                let count = format!(
                    "{cte}\n\
                     SELECT COUNT(*)\n\
                     FROM articles a\n\
                     WHERE a.user_id = (SELECT user_id FROM users WHERE name = ?)\n  \
                     AND a.status = 'published'\n\
                     {conds}"
                );
                (list, count)
            }
        };

        // 一覧クエリ Future を構築する
        // バインド順: [cte_tag_ids...], user_name, [exists_tag_ids... (AND のみ)], limit, offset
        let rows_future = {
            let mut q =
                sqlx::query_as::<_, ArticleSummaryBaseRow>(sqlx::AssertSqlSafe(list_sql.as_str()));
            if let Some(ids) = &resolved_ids {
                for id in ids {
                    q = q.bind(id.as_str());
                }
            }
            q = q.bind(user_name);
            if let (Some(ids), Some(TagFilterMode::And)) = (&resolved_ids, filter_mode) {
                for id in ids {
                    q = q.bind(id.as_str());
                }
            }
            q = q.bind(limit).bind(offset);
            observe_query(
                "article_list",
                list_sql.as_str(),
                q.fetch_all(&pool),
                |rows| Some(rows.len() as i64),
            )
        };

        // カウントクエリ Future を構築する
        // バインド順: [cte_tag_ids...], user_name, [exists_tag_ids... (AND のみ)]
        let count_future = {
            let mut q = sqlx::query_as::<_, (i64,)>(sqlx::AssertSqlSafe(count_sql.as_str()));
            if let Some(ids) = &resolved_ids {
                for id in ids {
                    q = q.bind(id.as_str());
                }
            }
            q = q.bind(user_name);
            if let (Some(ids), Some(TagFilterMode::And)) = (&resolved_ids, filter_mode) {
                for id in ids {
                    q = q.bind(id.as_str());
                }
            }
            observe_query(
                "article_list_count",
                count_sql.as_str(),
                q.fetch_one(&pool),
                |_| Some(1),
            )
        };

        // DB が Tailscale 越しで RTT が大きいため、一覧と件数を並列に投げる
        let (rows, total_count) = tokio::try_join!(rows_future, count_future)?;

        let mut articles: Vec<ArticleSummary> = rows
            .into_iter()
            .map(ArticleSummary::try_from)
            .collect::<Result<_, _>>()?;

        // ページ内記事のタグを別クエリで取得してマージする
        if !articles.is_empty() {
            let article_ids: Vec<String> = articles
                .iter()
                .map(|a| a.article_id.as_uuid().to_string())
                .collect();
            let mut tags_map = fetch_article_tags(&pool, &article_ids).await?;
            for article in &mut articles {
                let id_str = article.article_id.as_uuid().to_string();
                if let Some(tags) = tags_map.remove(&id_str) {
                    article.tags = tags;
                }
            }
        }

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
        // 詳細ページは常に1記事のため、相関サブクエリ方式を維持する
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

    async fn search_published_by_user_name(
        &self,
        user_name: &str,
        vector: &[f32],
        tag_filter: Option<&TagFilter>,
        candidate_limit: u64,
        limit: u64,
        offset: u64,
    ) -> Result<ArticleSearchResultPage, anyhow::Error> {
        let pool = self.db.pool();
        let vector_json = serde_json::to_string(vector)?;
        let candidate_limit = candidate_limit.max(limit);

        let resolved_ids: Option<Vec<String>> = match tag_filter {
            None => None,
            Some(filter) if filter.is_empty() => None,
            Some(filter) => {
                let resolved = resolve_tag_ids_for_paths(&pool, &filter.paths).await?;
                match filter.mode {
                    TagFilterMode::And => {
                        if resolved.iter().any(Option::is_none) {
                            return Ok(ArticleSearchResultPage {
                                results: vec![],
                                total_count: 0,
                            });
                        }
                        Some(resolved.into_iter().flatten().collect())
                    }
                    TagFilterMode::Or => {
                        let ids: Vec<String> = resolved.into_iter().flatten().collect();
                        if ids.is_empty() {
                            return Ok(ArticleSearchResultPage {
                                results: vec![],
                                total_count: 0,
                            });
                        }
                        Some(ids)
                    }
                }
            }
        };
        let filter_mode = tag_filter.map(|filter| &filter.mode);

        // user/status filterをHNSWの内側に置くとTiFlash全走査になるため、まずchunkの
        // ANN候補を取得する。外側で公開記事へ絞り、同一記事は最小distanceだけを残す。
        let search_sql = build_search_sql(resolved_ids.as_deref(), filter_mode);

        let mut query =
            sqlx::query_as::<_, ArticleSearchRow>(sqlx::AssertSqlSafe(search_sql.as_str()));
        if let Some(ids) = &resolved_ids {
            for id in ids {
                query = query.bind(id.as_str());
            }
        }
        query = query
            .bind(&vector_json)
            .bind(&vector_json)
            .bind(candidate_limit)
            .bind(user_name);
        if let (Some(ids), Some(TagFilterMode::And)) = (&resolved_ids, filter_mode) {
            for id in ids {
                query = query.bind(id.as_str());
            }
        }
        query = query.bind(limit).bind(offset);

        let rows: Vec<ArticleSearchRow> = observe_query(
            "article_vector_search",
            search_sql.as_str(),
            query.fetch_all(&pool),
            |rows| Some(rows.len() as i64),
        )
        .await?;

        let total_count = rows.first().map(|r| r.total_count as u64).unwrap_or(0);

        let mut results: Vec<ArticleSearchResult> = rows
            .into_iter()
            .map(ArticleSearchResult::try_from)
            .collect::<Result<_, _>>()?;

        if !results.is_empty() {
            let article_ids: Vec<String> = results
                .iter()
                .map(|result| result.article.article_id.as_uuid().to_string())
                .collect();
            let mut tags_map = fetch_article_tags(&pool, &article_ids).await?;
            for result in &mut results {
                let id = result.article.article_id.as_uuid().to_string();
                if let Some(tags) = tags_map.remove(&id) {
                    result.article.tags = tags;
                }
            }
        }

        Ok(ArticleSearchResultPage {
            results,
            total_count,
        })
    }

    async fn find_tag_facets(
        &self,
        user_name: &str,
        tag_filter: Option<&TagFilter>,
    ) -> Result<TagFacetsResult, anyhow::Error> {
        let pool = self.db.pool();

        // タグフィルタが指定されている場合は tag_id を解決する
        let resolved_ids: Option<Vec<String>> = match tag_filter {
            None => None,
            Some(f) if f.is_empty() => None,
            Some(f) => {
                let resolved = resolve_tag_ids_for_paths(&pool, &f.paths).await?;
                match f.mode {
                    TagFilterMode::And => {
                        if resolved.iter().any(|r| r.is_none()) {
                            return Ok(TagFacetsResult { facets: vec![] });
                        }
                        Some(resolved.into_iter().flatten().collect())
                    }
                    TagFilterMode::Or => {
                        let ids: Vec<String> = resolved.into_iter().flatten().collect();
                        if ids.is_empty() {
                            return Ok(TagFacetsResult { facets: vec![] });
                        }
                        Some(ids)
                    }
                }
            }
        };

        let filter_mode: Option<&TagFilterMode> = tag_filter.map(|f| &f.mode);

        // ファセット集計 SQL を構築する。
        // フィルタなし（パネル初期表示・SSR 埋め込み用）: tag_article_counts 前計算テーブルを
        // そのまま読むだけなので O(タグ数) で完了し、事前の 44 秒超クエリを廃止できる。
        // フィルタあり（タグ選択後の再集計）: 絞り込み後の記事集合は小さいため、
        // 従来の祖先ロールアップクエリに MAX_EXECUTION_TIME(8000) を付けて実行し、
        // タイムアウト時は呼び出し元がエラーとして扱う。
        let facets_sql = match &resolved_ids {
            None => {
                // フィルタなし: tag_article_counts + tag_paths CTE でパス名を付けて返す。
                // tag_article_counts の type 列は廃止済み概念（新規書き込みは定数 'all'）だが、
                // 旧 per-type 行が残っている間も正しく合算できるよう SUM で読む
                // （列自体の削除はスキーマクリーンアップ時）。
                r#"WITH RECURSIVE tag_paths AS (
    SELECT tag_id, name AS path FROM tags WHERE parent_tag_id IS NULL
    UNION ALL
    SELECT t.tag_id, CONCAT(tp.path, '/', t.name) FROM tags t
    JOIN tag_paths tp ON t.parent_tag_id = tp.tag_id
)
SELECT tp.path, CAST(SUM(tac.article_count) AS SIGNED) AS cnt
FROM tag_article_counts tac
JOIN tag_paths tp ON tp.tag_id = tac.tag_id
WHERE tac.user_id = (SELECT user_id FROM users WHERE name = ?)
GROUP BY tac.tag_id, tp.path
HAVING cnt > 0
ORDER BY cnt DESC, tp.path ASC"#
                    .to_string()
            }
            Some(ids) => {
                let mode = filter_mode.unwrap();
                let (cte_body, filter_conds) = build_facets_filter_parts(ids, mode);
                // tag_descendants CTE を tag_ancestors の直後に追加する。
                // MAX_EXECUTION_TIME(8000) ヒントを付けて 8 秒でタイムアウトさせる。
                // 集計は anc_tag_id で行い、tag_paths の JOIN は集計後の高々タグ数行に対して行う。
                // 集計前に JOIN してパス文字列で GROUP BY すると、クラスタ実測で 5 倍以上遅い
                // （50万記事・ホット親タグ選択で 8.2s → 1.5s）。
                format!(
                    r#"WITH RECURSIVE
tag_paths AS (
    SELECT tag_id, name AS path FROM tags WHERE parent_tag_id IS NULL
    UNION ALL
    SELECT t.tag_id, CONCAT(tp.path, '/', t.name) FROM tags t
    JOIN tag_paths tp ON t.parent_tag_id = tp.tag_id
),
tag_ancestors AS (
    SELECT tag_id AS leaf_tag_id, tag_id AS anc_tag_id FROM tags
    UNION ALL
    SELECT ta.leaf_tag_id, t.parent_tag_id AS anc_tag_id FROM tag_ancestors ta
    JOIN tags t ON t.tag_id = ta.anc_tag_id WHERE t.parent_tag_id IS NOT NULL
),
{cte_body}
SELECT /*+ MAX_EXECUTION_TIME(8000) */ tp.path, agg.cnt
FROM (
    SELECT ta.anc_tag_id, COUNT(DISTINCT ats.article_id) AS cnt
    FROM articles a
    JOIN articles_tags ats ON ats.article_id = a.article_id
    JOIN tag_ancestors ta ON ta.leaf_tag_id = ats.tag_id
    WHERE a.user_id = (SELECT user_id FROM users WHERE name = ?)
      AND a.status = 'published'
    {filter_conds}
    GROUP BY ta.anc_tag_id
    HAVING cnt > 0
) agg
JOIN tag_paths tp ON tp.tag_id = agg.anc_tag_id
ORDER BY agg.cnt DESC, tp.path ASC"#
                )
            }
        };

        // バインド順: [cte_tag_ids...], user_name, [exists_tag_ids... (AND のみ)]
        let mut q = sqlx::query_as::<_, (String, i64)>(sqlx::AssertSqlSafe(facets_sql.as_str()));
        if let Some(ids) = &resolved_ids {
            for id in ids {
                q = q.bind(id.as_str());
            }
        }
        q = q.bind(user_name);
        if let (Some(ids), Some(TagFilterMode::And)) = (&resolved_ids, filter_mode) {
            for id in ids {
                q = q.bind(id.as_str());
            }
        }

        let rows: Vec<(String, i64)> = observe_query(
            "tag_facets",
            facets_sql.as_str(),
            q.fetch_all(&pool),
            |rows| Some(rows.len() as i64),
        )
        .await?;

        let facets = rows
            .into_iter()
            .map(|(path, cnt)| TagFacet {
                path,
                count: cnt as u64,
            })
            .collect();

        Ok(TagFacetsResult { facets })
    }
}

// ─────────────────────────────────────────
// Unit tests
// ─────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leaf_of_path_single_segment() {
        assert_eq!(leaf_of_path("rust"), "rust");
    }

    #[test]
    fn leaf_of_path_two_segments() {
        assert_eq!(leaf_of_path("tech/rust"), "rust");
    }

    #[test]
    fn leaf_of_path_three_segments() {
        assert_eq!(leaf_of_path("tech/aws/lambda"), "lambda");
    }

    #[test]
    fn leaf_of_path_empty_str() {
        // split('/').rev().next() on "" yields "", which we return as-is
        assert_eq!(leaf_of_path(""), "");
    }

    #[test]
    fn build_list_filter_parts_and_one_tag() {
        let ids = vec!["id1".to_string()];
        let (cte, conds) = build_list_filter_parts(&ids, &TagFilterMode::And);
        assert!(
            cte.contains("root_tag_id"),
            "AND CTE should contain root_tag_id"
        );
        assert!(cte.contains("IN (?)"), "CTE should have one placeholder");
        assert!(
            conds.contains("td.root_tag_id = ?"),
            "AND condition must bind root_tag_id"
        );
        assert!(conds.contains("at0"), "alias at0 expected");
    }

    #[test]
    fn build_list_filter_parts_and_two_tags() {
        let ids = vec!["id1".to_string(), "id2".to_string()];
        let (cte, conds) = build_list_filter_parts(&ids, &TagFilterMode::And);
        assert!(
            cte.contains("IN (?, ?)"),
            "CTE should have two placeholders"
        );
        assert!(conds.contains("at0"), "alias at0 expected");
        assert!(conds.contains("at1"), "alias at1 expected");
        // two separate EXISTS conditions
        assert_eq!(conds.matches("EXISTS").count(), 2);
    }

    #[test]
    fn build_list_filter_parts_or_mode() {
        let ids = vec!["id1".to_string(), "id2".to_string()];
        let (cte, conds) = build_list_filter_parts(&ids, &TagFilterMode::Or);
        assert!(
            !cte.contains("root_tag_id"),
            "OR CTE should not contain root_tag_id"
        );
        assert!(
            cte.contains("IN (?, ?)"),
            "CTE should have two placeholders"
        );
        // single EXISTS condition for OR
        assert_eq!(conds.matches("EXISTS").count(), 1);
        assert!(conds.contains("ats"), "OR uses alias 'ats'");
    }

    #[test]
    fn build_search_sql_without_tags_keeps_filters_outside_ann() {
        let sql = build_search_sql(None, None);
        assert!(sql.starts_with("WITH nearest_chunks"));
        assert!(!sql.contains("annIndex"));
        assert!(sql.contains("READ_FROM_STORAGE(TIFLASH[c])"));
        assert!(sql.contains("WHERE a.status = 'published' AND u.name = ?"));
        assert!(!sql.contains("tag_descendants"));
    }

    #[test]
    fn build_search_sql_with_tags_places_tag_filter_after_ann_cte() {
        let ids = vec!["id1".to_string(), "id2".to_string()];
        let sql = build_search_sql(Some(&ids), Some(&TagFilterMode::And));
        let nearest_position = sql.find("nearest_chunks AS").unwrap();
        let filter_position = sql.find("AND EXISTS").unwrap();
        assert!(sql.starts_with("WITH RECURSIVE tag_descendants"));
        assert!(filter_position > nearest_position);
        assert_eq!(sql.matches("AND EXISTS").count(), 2);
    }
}
