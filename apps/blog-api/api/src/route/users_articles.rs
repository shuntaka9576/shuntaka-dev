use axum::{Router, routing::get};
use registry::AppRegistry;

use crate::handler::users_articles::{
    get_users_article, get_users_articles, get_users_articles_tag_facets,
};

pub fn build_users_articles_routers() -> Router<AppRegistry> {
    // 静的セグメント "/articles/tag-facets" を動的セグメント "/articles/{slug}" より
    // 先に登録することで axum/matchit が静的パスを優先マッチする
    let routers = Router::new()
        .route("/articles", get(get_users_articles))
        .route("/articles/tag-facets", get(get_users_articles_tag_facets))
        .route("/articles/{slug}", get(get_users_article));

    Router::new().nest("/users/{name}", routers)
}
