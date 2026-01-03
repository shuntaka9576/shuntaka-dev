pub mod handler;
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
        handler::users_articles::get_users_article,
        handler::webhooks::handle_github_webhook,
    ),
    components(
        schemas(
            handler::users_articles::ArticleResponse,
            handler::users_articles::UsersArticlesResponse,
            handler::webhooks::WebhookResponse,
        )
    ),
    tags(
        (name = "health", description = "Health check endpoints"),
        (name = "users_articles", description = "User articles endpoints"),
        (name = "webhooks", description = "Webhook endpoints")
    )
)]
pub struct ApiDoc;
