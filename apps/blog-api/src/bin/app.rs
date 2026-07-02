use api::route::build_swagger_router;
use api::route::health::build_health_check_routers;
use api::route::users_articles::build_users_articles_routers;
use api::route::webhooks::build_webhooks_routers;
use registry::{AppRegistry, WebhookConfig};
use std::net::{Ipv4Addr, SocketAddr};

use adapter::database::connect_database_with;
use anyhow::{Error, Result};
use axum::Router;
use shared::config::AppConfig;
use tokio::net::TcpListener;
use tower_http::compression::CompressionLayer;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::{DefaultMakeSpan, DefaultOnResponse, TraceLayer};
use tracing::Level;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() -> Result<()> {
    bootstrap().await
}

async fn bootstrap() -> Result<()> {
    tracing_subscriber::registry()
        .with(tracing_subscriber::fmt::layer().json())
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "blog_api=debug,api=debug,tower_http=debug".into()),
        )
        .init();

    let app_config = AppConfig::new()?;
    let pool = connect_database_with(&app_config.database).await?;

    let webhook_config = WebhookConfig {
        github_app_id: app_config.webhook.github_app_id,
        github_app_secret_pem: app_config.webhook.github_app_secret_pem,
        github_webhook_secret: app_config.webhook.github_webhook_secret,
        articles_dir: app_config.webhook.articles_dir,
        cloudinary_cloud_name: app_config.webhook.cloudinary_cloud_name,
        cloudinary_api_key: app_config.webhook.cloudinary_api_key,
        cloudinary_api_secret: app_config.webhook.cloudinary_api_secret,
        ogp_public_id: app_config.webhook.ogp_public_id,
    };

    let registry = AppRegistry::new(pool, webhook_config).await;

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .merge(build_health_check_routers())
        .merge(build_users_articles_routers())
        .merge(build_webhooks_routers())
        .merge(build_swagger_router())
        .layer(
            TraceLayer::new_for_http()
                .make_span_with(DefaultMakeSpan::new().level(Level::INFO))
                .on_response(DefaultOnResponse::new().level(Level::INFO)),
        )
        .layer(cors)
        // syntect がインライン style を吐くため content_html が大きく、gzip の効果が高い
        .layer(CompressionLayer::new())
        .with_state(registry);

    let addr = SocketAddr::new(Ipv4Addr::UNSPECIFIED.into(), app_config.server.port);
    let listener = TcpListener::bind(&addr).await?;

    println!("Listening on {addr}");

    axum::serve(listener, app).await.map_err(Error::from)
}
