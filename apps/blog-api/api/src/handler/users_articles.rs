use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderName, HeaderValue},
    Json,
};
use infrastructure::cloudinary::client::{CloudinaryClient, CloudinaryClientImpl};
use kernel::model::article::ArticleType;
use markdown::convert_markdown_to_html;
use registry::AppRegistry;
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use crate::error::AppError;

const DEFAULT_PER_PAGE: u32 = 10;
const MAX_PER_PAGE: u32 = 500;

// 公開済み記事しか返さない API のため、CDN / ブラウザ双方でキャッシュを許可する
const CACHE_CONTROL_PUBLIC: (HeaderName, HeaderValue) = (
    header::CACHE_CONTROL,
    HeaderValue::from_static("public, max-age=60, stale-while-revalidate=300"),
);

#[derive(Debug, Deserialize, IntoParams)]
pub struct UsersArticlesQuery {
    #[serde(rename = "type")]
    pub article_type: String,
    pub page: Option<u32>,
    #[serde(rename = "perPage")]
    pub per_page: Option<String>,
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
    #[serde(rename = "type")]
    pub article_type: Option<String>,
    pub thumbnail: Option<String>,
    pub ogp_url: String,
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
    #[serde(rename = "type")]
    pub article_type: Option<String>,
    pub thumbnail: Option<String>,
    pub ogp_url: String,
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

#[utoipa::path(
    get,
    path = "/users/{name}/articles",
    params(
        ("name" = String, Path, description = "User name"),
        UsersArticlesQuery,
    ),
    responses(
        (status = 200, description = "Article list retrieved successfully", body = UsersArticlesResponse),
        (status = 400, description = "Invalid article type"),
        (status = 500, description = "Internal server error")
    ),
    tag = "users_articles"
)]
pub async fn get_users_articles(
    State(registry): State<AppRegistry>,
    Path(name): Path<String>,
    Query(query): Query<UsersArticlesQuery>,
) -> Result<([(HeaderName, HeaderValue); 1], Json<UsersArticlesResponse>), AppError> {
    let article_type = ArticleType::new(query.article_type)
        .map_err(|_| AppError::bad_request("Invalid article type"))?;

    let page = query.page.unwrap_or(1).max(1);
    let per_page = parse_per_page(query.per_page.as_deref())?;

    let offset = (u64::from(page) - 1) * u64::from(per_page);
    let limit = u64::from(per_page);

    let result = registry
        .users_articles_repository()
        .find_published_by_user_name_and_type(&name, &article_type, offset, limit)
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
                    article_type: article.article_type.map(|t| t.into_inner()),
                    thumbnail: article.thumbnail.map(|t| t.into_inner()),
                    ogp_url,
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
    let content_html = convert_markdown_to_html(&content);
    let ogp_url = cloudinary.create_signed_ogp_url(&config.ogp_public_id, &title, "webp");

    let response = ArticleResponse {
        article_id: article.article_id.into_inner().to_string(),
        title,
        slug: article.slug.into_inner(),
        content,
        content_html,
        description: article.description.into_inner(),
        article_type: article.article_type.map(|t| t.into_inner()),
        thumbnail: article.thumbnail.map(|t| t.into_inner()),
        ogp_url,
        published_at: article.published_at.map(|d| d.to_rfc3339()),
        created_at: article.created_at.map(|d| d.to_rfc3339()),
        updated_at: article.updated_at.map(|d| d.to_rfc3339()),
    };

    Ok(([CACHE_CONTROL_PUBLIC], Json(response)))
}
