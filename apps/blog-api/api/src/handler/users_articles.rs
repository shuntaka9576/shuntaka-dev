use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderName, HeaderValue, header},
};
use infrastructure::cloudinary::client::{CloudinaryClient, CloudinaryClientImpl};
use kernel::model::article::{TagFilter, TagFilterMode};
use markdown::convert_markdown_to_html;
use registry::AppRegistry;
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use crate::error::AppError;

const DEFAULT_PER_PAGE: u32 = 10;
const MAX_PER_PAGE: u32 = 500;
const DEFAULT_SEARCH_LIMIT: u32 = 20;
const MAX_SEARCH_LIMIT: u32 = 100;
const MAX_SEARCH_OFFSET: u32 = 200;
const MAX_SEARCH_QUERY_CHARS: usize = 500;
const SEARCH_CANDIDATE_MULTIPLIER: u32 = 10;
const TAGGED_SEARCH_CANDIDATE_MULTIPLIER: u32 = 30;
const MAX_SEARCH_CANDIDATES: u32 = 3000;

// 公開済み記事しか返さない API のため、CDN / ブラウザ双方でキャッシュを許可する
const CACHE_CONTROL_PUBLIC: (HeaderName, HeaderValue) = (
    header::CACHE_CONTROL,
    HeaderValue::from_static("public, max-age=60, stale-while-revalidate=300"),
);

#[derive(Debug, Deserialize, IntoParams)]
pub struct UsersArticlesQuery {
    /// Page number (1-based, default 1)
    pub page: Option<u32>,
    /// Number of articles per page. Use "all" for maximum (capped at 500).
    #[serde(rename = "perPage")]
    pub per_page: Option<String>,
    /// Comma-separated full-path tags for filtering (e.g. "tech/rust,tech/aws/lambda").
    /// Omit to return all articles.
    pub tags: Option<String>,
    /// Tag filter mode: "and" (default, all tags must match) or "or" (any tag matches).
    /// Ignored when `tags` is omitted or contains a single tag.
    pub mode: Option<String>,
}

#[derive(Debug, Deserialize, IntoParams)]
pub struct UsersArticlesTagFacetsQuery {
    /// Comma-separated full-path tags to pre-filter the article set before aggregation.
    /// Omit to aggregate over all published articles.
    pub tags: Option<String>,
    /// Tag filter mode for the pre-filter: "and" (default) or "or".
    pub mode: Option<String>,
}

#[derive(Debug, Deserialize, IntoParams)]
pub struct UsersArticlesSearchQuery {
    /// Semantic search query.
    pub q: String,
    /// Comma-separated full-path tags for post-filtering the ANN candidates.
    pub tags: Option<String>,
    /// Tag filter mode: "and" (default) or "or".
    pub mode: Option<String>,
    /// Maximum number of unique articles to return per page (default 20, max 100).
    pub limit: Option<u32>,
    /// Number of results to skip for pagination (default 0, max 200).
    pub offset: Option<u32>,
}

#[derive(Debug, Deserialize)]
pub struct ArticlePath {
    pub name: String,
    pub slug: String,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[schema(rename_all = "camelCase")]
pub struct ArticleResponse {
    pub article_id: String,
    pub title: String,
    pub slug: String,
    pub content: String,
    pub content_html: String,
    pub description: String,
    pub thumbnail: Option<String>,
    pub ogp_url: String,
    /// フルパス表記のタグ（例: "rust", "aws/lambda"）
    pub tags: Vec<String>,
    pub published_at: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[schema(rename_all = "camelCase")]
pub struct ArticleSummaryResponse {
    pub article_id: String,
    pub title: String,
    pub slug: String,
    pub description: String,
    pub thumbnail: Option<String>,
    pub ogp_url: String,
    /// フルパス表記のタグ（例: "rust", "aws/lambda"）
    pub tags: Vec<String>,
    pub published_at: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[schema(rename_all = "camelCase")]
pub struct UsersArticlesResponse {
    pub articles: Vec<ArticleSummaryResponse>,
    pub total_count: u64,
    pub page: u32,
    pub per_page: u32,
    pub total_pages: u32,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[schema(rename_all = "camelCase")]
pub struct ArticleSearchResultResponse {
    pub article_id: String,
    pub title: String,
    pub slug: String,
    pub description: String,
    pub thumbnail: Option<String>,
    pub ogp_url: String,
    pub tags: Vec<String>,
    pub published_at: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    /// Cosine distance. Smaller values indicate a closer semantic match.
    pub distance: f64,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[schema(rename_all = "camelCase")]
pub struct UsersArticlesSearchResponse {
    pub articles: Vec<ArticleSearchResultResponse>,
    pub query: String,
    pub limit: u32,
    pub offset: u32,
    pub total_count: u64,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TagFacetEntry {
    /// Full-path tag (e.g. "tech/aws" or "tech/aws/lambda")
    pub path: String,
    /// Number of published articles that match this tag (including descendant tags)
    pub count: u64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct TagFacetsResponse {
    /// Tag facets sorted by count descending, then path ascending. Count-zero tags are omitted.
    pub facets: Vec<TagFacetEntry>,
}

// ─────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────

/// `tags` クエリパラメータ（カンマ区切りのフルパス）と `mode` から TagFilter を生成する。
/// `tags` が省略または空の場合は None を返す。
fn parse_tag_filter(tags: Option<&str>, mode: Option<&str>) -> Option<TagFilter> {
    let tags_str = tags?;
    let paths: Vec<String> = tags_str
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if paths.is_empty() {
        return None;
    }
    let filter_mode = TagFilterMode::from_str_or_default(mode.unwrap_or("and"));
    Some(TagFilter::new(paths, filter_mode))
}

fn parse_per_page(raw: Option<&str>) -> Result<u32, AppError> {
    let Some(value) = raw else {
        return Ok(DEFAULT_PER_PAGE);
    };
    if value.eq_ignore_ascii_case("all") {
        return Ok(MAX_PER_PAGE);
    }
    let parsed: u32 = value
        .parse()
        .map_err(|_| AppError::bad_request("Invalid perPage value"))?;
    if parsed == 0 {
        return Err(AppError::bad_request("perPage must be >= 1"));
    }
    if parsed > MAX_PER_PAGE {
        return Err(AppError::bad_request("perPage exceeds maximum"));
    }
    Ok(parsed)
}

fn parse_search_query(raw: &str) -> Result<&str, AppError> {
    let query = raw.trim();
    if query.is_empty() {
        return Err(AppError::bad_request("q must not be empty"));
    }
    if query.chars().count() > MAX_SEARCH_QUERY_CHARS {
        return Err(AppError::bad_request("q exceeds maximum length"));
    }
    Ok(query)
}

fn parse_search_limit(raw: Option<u32>) -> Result<u32, AppError> {
    let limit = raw.unwrap_or(DEFAULT_SEARCH_LIMIT);
    if limit == 0 {
        return Err(AppError::bad_request("limit must be >= 1"));
    }
    if limit > MAX_SEARCH_LIMIT {
        return Err(AppError::bad_request("limit exceeds maximum"));
    }
    Ok(limit)
}

fn parse_search_offset(raw: Option<u32>) -> Result<u32, AppError> {
    let offset = raw.unwrap_or(0);
    if offset > MAX_SEARCH_OFFSET {
        return Err(AppError::bad_request("offset exceeds maximum"));
    }
    Ok(offset)
}

fn search_candidate_limit(limit: u32, offset: u32, has_tag_filter: bool) -> u32 {
    let effective = limit.saturating_add(offset);
    let multiplier = if has_tag_filter {
        TAGGED_SEARCH_CANDIDATE_MULTIPLIER
    } else {
        SEARCH_CANDIDATE_MULTIPLIER
    };
    effective.saturating_mul(multiplier).min(MAX_SEARCH_CANDIDATES)
}

// ─────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────

#[utoipa::path(
    get,
    path = "/users/{name}/articles",
    params(
        ("name" = String, Path, description = "User name"),
        UsersArticlesQuery,
    ),
    responses(
        (status = 200, description = "Article list retrieved successfully", body = UsersArticlesResponse),
        (status = 400, description = "Invalid perPage"),
        (status = 500, description = "Internal server error")
    ),
    tag = "users_articles"
)]
pub async fn get_users_articles(
    State(registry): State<AppRegistry>,
    Path(name): Path<String>,
    Query(query): Query<UsersArticlesQuery>,
) -> Result<([(HeaderName, HeaderValue); 1], Json<UsersArticlesResponse>), AppError> {
    let page = query.page.unwrap_or(1).max(1);
    let per_page = parse_per_page(query.per_page.as_deref())?;
    let offset = (u64::from(page) - 1) * u64::from(per_page);
    let limit = u64::from(per_page);

    let tag_filter = parse_tag_filter(query.tags.as_deref(), query.mode.as_deref());

    let result = registry
        .users_articles_repository()
        .find_published_by_user_name(&name, tag_filter.as_ref(), offset, limit)
        .await
        .map_err(|e| AppError::internal("Failed to find articles", e))?;

    let config = registry.webhook_config();
    let cloudinary = CloudinaryClientImpl::new(
        config.cloudinary_cloud_name.clone(),
        config.cloudinary_api_secret.clone(),
    );

    let total_pages = if result.total_count == 0 {
        0
    } else {
        result.total_count.div_ceil(u64::from(per_page)) as u32
    };

    let response = UsersArticlesResponse {
        articles: result
            .articles
            .into_iter()
            .map(|article| {
                let slug = article.slug.into_inner();
                let title = article.title.into_inner();
                let ogp_url =
                    cloudinary.create_signed_ogp_url(&config.ogp_public_id, &title, "webp");

                ArticleSummaryResponse {
                    article_id: article.article_id.into_inner().to_string(),
                    title,
                    slug,
                    description: article.description.into_inner(),
                    thumbnail: article.thumbnail.map(|t| t.into_inner()),
                    ogp_url,
                    tags: article.tags,
                    published_at: article.published_at.map(|d| d.to_rfc3339()),
                    created_at: article.created_at.map(|d| d.to_rfc3339()),
                    updated_at: article.updated_at.map(|d| d.to_rfc3339()),
                }
            })
            .collect(),
        total_count: result.total_count,
        page,
        per_page,
        total_pages,
    };

    Ok(([CACHE_CONTROL_PUBLIC], Json(response)))
}

#[utoipa::path(
    get,
    path = "/users/{name}/articles/search",
    params(
        ("name" = String, Path, description = "User name"),
        UsersArticlesSearchQuery,
    ),
    responses(
        (status = 200, description = "Semantic article search completed", body = UsersArticlesSearchResponse),
        (status = 400, description = "Invalid query or limit"),
        (status = 502, description = "Embedding service request failed"),
        (status = 503, description = "Embedding service is not configured"),
        (status = 500, description = "Internal server error")
    ),
    tag = "users_articles"
)]
pub async fn get_users_articles_search(
    State(registry): State<AppRegistry>,
    Path(name): Path<String>,
    Query(query): Query<UsersArticlesSearchQuery>,
) -> Result<
    (
        [(HeaderName, HeaderValue); 1],
        Json<UsersArticlesSearchResponse>,
    ),
    AppError,
> {
    let search_query = parse_search_query(&query.q)?;
    let limit = parse_search_limit(query.limit)?;
    let offset = parse_search_offset(query.offset)?;
    let tag_filter = parse_tag_filter(query.tags.as_deref(), query.mode.as_deref());
    let candidate_limit = search_candidate_limit(limit, offset, tag_filter.is_some());

    let embedding_client = registry.embedding_client().ok_or_else(|| {
        AppError::service_unavailable("PLaMO embedding service is not configured")
    })?;
    let vector = embedding_client
        .embed_query(search_query)
        .await
        .map_err(|error| AppError::bad_gateway("Failed to generate query embedding", error))?;

    let search_result = registry
        .users_articles_repository()
        .search_published_by_user_name(
            &name,
            &vector,
            tag_filter.as_ref(),
            u64::from(candidate_limit),
            u64::from(limit),
            u64::from(offset),
        )
        .await
        .map_err(|error| AppError::internal("Failed to search articles", error))?;

    let config = registry.webhook_config();
    let cloudinary = CloudinaryClientImpl::new(
        config.cloudinary_cloud_name.clone(),
        config.cloudinary_api_secret.clone(),
    );
    let articles = search_result
        .results
        .into_iter()
        .map(|result| {
            let article = result.article;
            let title = article.title.into_inner();
            let ogp_url = cloudinary.create_signed_ogp_url(&config.ogp_public_id, &title, "webp");
            ArticleSearchResultResponse {
                article_id: article.article_id.into_inner().to_string(),
                title,
                slug: article.slug.into_inner(),
                description: article.description.into_inner(),
                thumbnail: article.thumbnail.map(|value| value.into_inner()),
                ogp_url,
                tags: article.tags,
                published_at: article.published_at.map(|value| value.to_rfc3339()),
                created_at: article.created_at.map(|value| value.to_rfc3339()),
                updated_at: article.updated_at.map(|value| value.to_rfc3339()),
                distance: result.distance,
            }
        })
        .collect();

    Ok((
        [CACHE_CONTROL_PUBLIC],
        Json(UsersArticlesSearchResponse {
            articles,
            query: search_query.to_string(),
            limit,
            offset,
            total_count: search_result.total_count,
        }),
    ))
}

#[utoipa::path(
    get,
    path = "/users/{name}/articles/tag-facets",
    params(
        ("name" = String, Path, description = "User name"),
        UsersArticlesTagFacetsQuery,
    ),
    responses(
        (status = 200, description = "Tag facets retrieved successfully", body = TagFacetsResponse),
        (status = 500, description = "Internal server error")
    ),
    tag = "users_articles"
)]
pub async fn get_users_articles_tag_facets(
    State(registry): State<AppRegistry>,
    Path(name): Path<String>,
    Query(query): Query<UsersArticlesTagFacetsQuery>,
) -> Result<([(HeaderName, HeaderValue); 1], Json<TagFacetsResponse>), AppError> {
    let tag_filter = parse_tag_filter(query.tags.as_deref(), query.mode.as_deref());

    let result = registry
        .users_articles_repository()
        .find_tag_facets(&name, tag_filter.as_ref())
        .await
        .map_err(|e| AppError::internal("Failed to find tag facets", e))?;

    let response = TagFacetsResponse {
        facets: result
            .facets
            .into_iter()
            .map(|f| TagFacetEntry {
                path: f.path,
                count: f.count,
            })
            .collect(),
    };

    Ok(([CACHE_CONTROL_PUBLIC], Json(response)))
}

#[utoipa::path(
    get,
    path = "/users/{name}/articles/{slug}",
    params(
        ("name" = String, Path, description = "User name"),
        ("slug" = String, Path, description = "Article slug"),
    ),
    responses(
        (status = 200, description = "Article retrieved successfully", body = ArticleResponse),
        (status = 404, description = "Article not found"),
        (status = 500, description = "Internal server error")
    ),
    tag = "users_articles"
)]
pub async fn get_users_article(
    State(registry): State<AppRegistry>,
    Path(path): Path<ArticlePath>,
) -> Result<([(HeaderName, HeaderValue); 1], Json<ArticleResponse>), AppError> {
    let article = registry
        .users_articles_repository()
        .find_published_by_user_name_and_slug(&path.name, &path.slug)
        .await
        .map_err(|e| AppError::internal("Failed to find article", e))?
        .ok_or_else(|| AppError::not_found("Article not found"))?;

    let config = registry.webhook_config();
    let cloudinary = CloudinaryClientImpl::new(
        config.cloudinary_cloud_name.clone(),
        config.cloudinary_api_secret.clone(),
    );

    let title = article.title.into_inner();
    let content = article.content.into_inner();
    // webhook upsert 時に事前生成した HTML を返す。未生成の旧レコードのみ
    // オンザフライ変換にフォールバック（同期 HTTP フェッチを含むため blocking スレッドで実行）
    let content_html = match article.content_html {
        Some(html) => html.into_inner(),
        None => {
            let markdown_content = content.clone();
            tokio::task::spawn_blocking(move || convert_markdown_to_html(&markdown_content))
                .await
                .map_err(|e| AppError::internal("Failed to convert markdown", e))?
        }
    };
    let ogp_url = cloudinary.create_signed_ogp_url(&config.ogp_public_id, &title, "webp");

    let response = ArticleResponse {
        article_id: article.article_id.into_inner().to_string(),
        title,
        slug: article.slug.into_inner(),
        content,
        content_html,
        description: article.description.into_inner(),
        thumbnail: article.thumbnail.map(|t| t.into_inner()),
        ogp_url,
        tags: article.tags,
        published_at: article.published_at.map(|d| d.to_rfc3339()),
        created_at: article.created_at.map(|d| d.to_rfc3339()),
        updated_at: article.updated_at.map(|d| d.to_rfc3339()),
    };

    Ok(([CACHE_CONTROL_PUBLIC], Json(response)))
}

// ─────────────────────────────────────────
// Unit tests
// ─────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_tag_filter_none_when_tags_absent() {
        assert!(parse_tag_filter(None, None).is_none());
    }

    #[test]
    fn parse_tag_filter_none_when_tags_empty_string() {
        assert!(parse_tag_filter(Some(""), None).is_none());
        assert!(parse_tag_filter(Some("  ,  "), None).is_none());
    }

    #[test]
    fn parse_tag_filter_single_tag_and_mode() {
        let f = parse_tag_filter(Some("tech/rust"), None).unwrap();
        assert_eq!(f.paths, vec!["tech/rust"]);
        assert_eq!(f.mode, TagFilterMode::And);
    }

    #[test]
    fn parse_tag_filter_multiple_tags_or_mode() {
        let f = parse_tag_filter(Some("tech/rust,tech/aws/lambda"), Some("or")).unwrap();
        assert_eq!(f.paths, vec!["tech/rust", "tech/aws/lambda"]);
        assert_eq!(f.mode, TagFilterMode::Or);
    }

    #[test]
    fn parse_tag_filter_trims_whitespace_around_commas() {
        let f = parse_tag_filter(Some(" tech/rust , tech/aws "), None).unwrap();
        assert_eq!(f.paths, vec!["tech/rust", "tech/aws"]);
    }

    #[test]
    fn parse_tag_filter_invalid_mode_defaults_to_and() {
        let f = parse_tag_filter(Some("tech/rust"), Some("xor")).unwrap();
        assert_eq!(f.mode, TagFilterMode::And);
    }

    #[test]
    fn parse_per_page_defaults() {
        assert_eq!(parse_per_page(None).unwrap(), DEFAULT_PER_PAGE);
    }

    #[test]
    fn parse_per_page_all() {
        assert_eq!(parse_per_page(Some("all")).unwrap(), MAX_PER_PAGE);
        assert_eq!(parse_per_page(Some("ALL")).unwrap(), MAX_PER_PAGE);
    }

    #[test]
    fn parse_per_page_numeric() {
        assert_eq!(parse_per_page(Some("20")).unwrap(), 20);
    }

    #[test]
    fn parse_per_page_zero_is_error() {
        assert!(parse_per_page(Some("0")).is_err());
    }

    #[test]
    fn parse_per_page_over_max_is_error() {
        assert!(parse_per_page(Some("501")).is_err());
    }

    #[test]
    fn parse_search_query_trims_whitespace() {
        assert_eq!(parse_search_query("  Rust Axum  ").unwrap(), "Rust Axum");
    }

    #[test]
    fn parse_search_query_rejects_empty() {
        assert!(parse_search_query("   ").is_err());
    }

    #[test]
    fn parse_search_query_rejects_over_maximum() {
        let query = "あ".repeat(MAX_SEARCH_QUERY_CHARS + 1);
        assert!(parse_search_query(&query).is_err());
    }

    #[test]
    fn parse_search_limit_defaults_and_validates_range() {
        assert_eq!(parse_search_limit(None).unwrap(), DEFAULT_SEARCH_LIMIT);
        assert_eq!(parse_search_limit(Some(1)).unwrap(), 1);
        assert_eq!(
            parse_search_limit(Some(MAX_SEARCH_LIMIT)).unwrap(),
            MAX_SEARCH_LIMIT
        );
        assert!(parse_search_limit(Some(0)).is_err());
        assert!(parse_search_limit(Some(MAX_SEARCH_LIMIT + 1)).is_err());
    }

    #[test]
    fn parse_search_offset_defaults_and_validates() {
        assert_eq!(parse_search_offset(None).unwrap(), 0);
        assert_eq!(parse_search_offset(Some(0)).unwrap(), 0);
        assert_eq!(
            parse_search_offset(Some(MAX_SEARCH_OFFSET)).unwrap(),
            MAX_SEARCH_OFFSET
        );
        assert!(parse_search_offset(Some(MAX_SEARCH_OFFSET + 1)).is_err());
    }

    #[test]
    fn search_candidates_expand_when_tags_are_present() {
        assert_eq!(search_candidate_limit(20, 0, false), 200);
        assert_eq!(search_candidate_limit(20, 0, true), 600);
        assert_eq!(search_candidate_limit(MAX_SEARCH_LIMIT, 0, true), 3000);
    }

    #[test]
    fn search_candidates_expand_with_offset() {
        assert_eq!(search_candidate_limit(20, 20, false), 400);
        assert_eq!(search_candidate_limit(20, 20, true), 1200);
    }
}
