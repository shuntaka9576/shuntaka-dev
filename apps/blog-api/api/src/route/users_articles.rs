use axum::{Router, routing::get};
use registry::AppRegistry;

use crate::handler::users_articles::{get_users_article, get_users_articles};

pub fn build_users_articles_routers() -> Router<AppRegistry> {
    let routers = Router::new()
        .route("/articles", get(get_users_articles))
        .route("/articles/{slug}", get(get_users_article));

    Router::new().nest("/users/{name}", routers)
}
