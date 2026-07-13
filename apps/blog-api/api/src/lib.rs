pub mod error;
pub mod handler;
pub mod observability;
pub mod route;

use utoipa::OpenApi;

#[derive(OpenApi)]
#[openapi(
    info(
        title = "Blog API",
        version = "0.1.0",
        description = "A RESTful API for blog management",
    ),
    paths(
        handler::health::health_check,
        handler::health::health_check_db,
        handler::users_articles::get_users_articles,
        handler::users_articles::get_users_articles_tag_facets,
        handler::users_articles::get_users_article,
        handler::users_moments::get_users_moments,
        handler::webhooks::handle_github_webhook,
    ),
    components(
        schemas(
            handler::users_articles::ArticleResponse,
            handler::users_articles::ArticleSummaryResponse,
            handler::users_articles::UsersArticlesResponse,
            handler::users_articles::TagFacetEntry,
            handler::users_articles::TagFacetsResponse,
            handler::users_moments::MomentSummaryResponse,
            handler::users_moments::UsersMomentsResponse,
            handler::webhooks::WebhookResponse,
        )
    ),
    tags(
        (name = "health", description = "Health check endpoints"),
        (name = "users_articles", description = "User articles endpoints"),
        (name = "users_moments", description = "User moments endpoints"),
        (name = "webhooks", description = "Webhook endpoints")
    )
)]
pub struct ApiDoc;
