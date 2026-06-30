use axum::{
    extract::{Path, Query, State},
    Json,
};
use infrastructure::cloudinary::client::{CloudinaryClient, CloudinaryClientImpl};
use kernel::model::article::ArticleType;
use markdown::convert_markdown_to_html;
use registry::AppRegistry;
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use crate::error::AppError;

#[derive(Debug, Deserialize, IntoParams)]
pub struct UsersArticlesQuery {
    #[serde(rename = "type")]
    pub article_type: String,
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
pub struct UsersArticlesResponse {
    pub articles: Vec<ArticleSummaryResponse>,
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
) -> Result<Json<UsersArticlesResponse>, AppError> {
    let article_type = ArticleType::new(query.article_type)
        .map_err(|_| AppError::bad_request("Invalid article type"))?;

    let articles = registry
        .users_articles_repository()
        .find_published_by_user_name_and_type(&name, &article_type)
        .await
        .map_err(|e| AppError::internal("Failed to find articles", e))?;

    let config = registry.webhook_config();
    let cloudinary = CloudinaryClientImpl::new(
        config.cloudinary_cloud_name.clone(),
        config.cloudinary_api_secret.clone(),
    );

    let response = UsersArticlesResponse {
        articles: articles
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
    };

    Ok(Json(response))
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
) -> Result<Json<ArticleResponse>, AppError> {
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

    Ok(Json(response))
}
