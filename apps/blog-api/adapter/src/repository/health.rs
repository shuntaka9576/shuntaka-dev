use async_trait::async_trait;
use derive_new::new;
use kernel::repository::health::HealthCheckRepository;

use crate::database::ConnectionPool;
use crate::observability::{HEALTHCHECK_QUERY_TYPE, observe_query};

#[derive(new)]
pub struct HealthCheckRepositoryImpl {
    db: ConnectionPool,
}

#[async_trait]
impl HealthCheckRepository for HealthCheckRepositoryImpl {
    async fn check_db(&self) -> bool {
        let sql = "SELECT 1";
        observe_query(
            HEALTHCHECK_QUERY_TYPE,
            sql,
            sqlx::query(sql).fetch_one(&self.db.pool()),
            |_| None,
        )
        .await
        .is_ok()
    }
}
