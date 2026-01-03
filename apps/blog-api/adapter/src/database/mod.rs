use anyhow::Result;
use aws_config::BehaviorVersion;
use aws_sdk_dsql::auth_token::{AuthTokenGenerator, Config as AuthConfig};
use shared::config::DatabaseConfig;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions, PgSslMode};
use sqlx::PgPool;

#[derive(Clone)]
pub struct ConnectionPool(PgPool);

impl ConnectionPool {
    pub fn inner_ref(&self) -> &PgPool {
        &self.0
    }
}

/// DSQL用の接続プールを作成
/// IAM認証トークンを使用してPostgreSQL互換接続を確立
pub async fn connect_database_with(cfg: &DatabaseConfig) -> Result<ConnectionPool> {
    let sdk_config = aws_config::load_defaults(BehaviorVersion::latest()).await;

    let signer = AuthTokenGenerator::new(
        AuthConfig::builder()
            .hostname(&cfg.cluster_endpoint)
            .build()
            .map_err(|e| anyhow::anyhow!("Failed to build auth config: {e:?}"))?,
    );

    let password_token = signer
        .db_connect_admin_auth_token(&sdk_config)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to generate auth token: {e:?}"))?;

    let connect_options = PgConnectOptions::new()
        .host(&cfg.cluster_endpoint)
        .port(5432)
        .database("postgres")
        .username("admin")
        .password(password_token.as_str())
        .ssl_mode(PgSslMode::Require);

    let pool = PgPoolOptions::new()
        .max_connections(10)
        .connect_with(connect_options)
        .await?;

    Ok(ConnectionPool(pool))
}
