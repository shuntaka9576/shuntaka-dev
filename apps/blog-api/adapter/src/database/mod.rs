use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use aws_config::BehaviorVersion;
use aws_sdk_dsql::auth_token::{AuthTokenGenerator, Config as AuthConfig};
use shared::config::DatabaseConfig;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions, PgSslMode};
use sqlx::PgPool;
use tokio::sync::RwLock;

/// Token refresh interval in seconds — 80% of the token lifetime (900s)
const REFRESH_INTERVAL_SECS: u64 = 720;

#[derive(Clone)]
pub struct ConnectionPool {
    pool: Arc<RwLock<PgPool>>,
    cluster_endpoint: String,
}

impl ConnectionPool {
    pub async fn pool(&self) -> PgPool {
        self.pool.read().await.clone()
    }

    /// Rebuild and swap the pool with a fresh IAM auth token
    async fn refresh(&self) -> Result<()> {
        tracing::info!("Refreshing database connection pool...");
        let new_pool = create_pool(&self.cluster_endpoint).await?;
        let old_pool = {
            let mut guard = self.pool.write().await;
            let old = guard.clone();
            *guard = new_pool;
            old
        };
        old_pool.close().await;
        tracing::info!("Database connection pool refreshed successfully");
        Ok(())
    }
}

/// Build a new PgPool (token generation + connection)
async fn create_pool(cluster_endpoint: &str) -> Result<PgPool> {
    let sdk_config = aws_config::load_defaults(BehaviorVersion::latest()).await;

    let signer = AuthTokenGenerator::new(
        AuthConfig::builder()
            .hostname(cluster_endpoint)
            .build()
            .map_err(|e| anyhow::anyhow!("Failed to build auth config: {e:?}"))?,
    );

    let password_token = signer
        .db_connect_admin_auth_token(&sdk_config)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to generate auth token: {e:?}"))?;

    let connect_options = PgConnectOptions::new()
        .host(cluster_endpoint)
        .port(5432)
        .database("postgres")
        .username("admin")
        .password(password_token.as_str())
        .ssl_mode(PgSslMode::Require);

    let pool = PgPoolOptions::new()
        .max_connections(10)
        .max_lifetime(None)
        .idle_timeout(None)
        .connect_with(connect_options)
        .await?;

    Ok(pool)
}

/// Create a connection pool for DSQL
/// Establishes a PostgreSQL-compatible connection using IAM auth token
pub async fn connect_database_with(cfg: &DatabaseConfig) -> Result<ConnectionPool> {
    let pool = create_pool(&cfg.cluster_endpoint).await?;

    Ok(ConnectionPool {
        pool: Arc::new(RwLock::new(pool)),
        cluster_endpoint: cfg.cluster_endpoint.clone(),
    })
}

/// Spawn a background task that periodically refreshes the pool
pub fn spawn_refresh_task(pool: ConnectionPool) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(REFRESH_INTERVAL_SECS));
        interval.tick().await; // 最初の tick はスキップ

        loop {
            interval.tick().await;
            if let Err(e) = pool.refresh().await {
                tracing::error!("Failed to refresh database connection pool: {e:?}");
            }
        }
    })
}
