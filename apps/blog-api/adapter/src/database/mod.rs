use anyhow::Result;
use aurora_dsql_sqlx_connector::DsqlConnectOptions;
use shared::config::DatabaseConfig;
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;

#[derive(Clone)]
pub struct ConnectionPool {
    pool: PgPool,
}

impl ConnectionPool {
    pub fn pool(&self) -> PgPool {
        self.pool.clone()
    }
}

async fn create_pool(cluster_endpoint: &str) -> Result<PgPool> {
    let connection_string = format!("postgres://admin@{cluster_endpoint}/postgres");
    let config = DsqlConnectOptions::from_connection_string(&connection_string)?;

    aurora_dsql_sqlx_connector::pool::connect_with(
        &config,
        PgPoolOptions::new()
            .max_connections(10)
            .max_lifetime(None)
            .idle_timeout(None),
    )
    .await
    .map_err(Into::into)
}

/// Create a connection pool for DSQL
/// Establishes a PostgreSQL-compatible connection using IAM auth token
pub async fn connect_database_with(cfg: &DatabaseConfig) -> Result<ConnectionPool> {
    let pool = create_pool(&cfg.cluster_endpoint).await?;

    Ok(ConnectionPool { pool })
}
