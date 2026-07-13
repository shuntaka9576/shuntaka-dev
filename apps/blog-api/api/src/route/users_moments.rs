use axum::{Router, routing::get};
use registry::AppRegistry;

use crate::handler::users_moments::get_users_moments;

pub fn build_users_moments_routers() -> Router<AppRegistry> {
    let routers = Router::new().route("/moments", get(get_users_moments));

    Router::new().nest("/users/{name}", routers)
}
