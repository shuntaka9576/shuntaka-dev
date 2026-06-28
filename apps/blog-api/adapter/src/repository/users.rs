use async_trait::async_trait;
use derive_new::new;
use kernel::model::article::UserId;
use kernel::repository::users::UsersRepository;
use sqlx::FromRow;
use uuid::Uuid;

use crate::database::ConnectionPool;

#[derive(FromRow)]
struct UserIdRow {
    user_id: String,
}

#[derive(new)]
pub struct UsersRepositoryImpl {
    db: ConnectionPool,
}

#[async_trait]
impl UsersRepository for UsersRepositoryImpl {
    async fn find_by_installation_id(
        &self,
        installation_id: i64,
    ) -> Result<Option<UserId>, anyhow::Error> {
        let row: Option<UserIdRow> = sqlx::query_as(
            r#"
            SELECT user_id
            FROM users
            WHERE github_installation_id = ?
            "#,
        )
        .bind(installation_id)
        .fetch_optional(&self.db.pool())
        .await?;

        row.map(|r| {
            Uuid::parse_str(&r.user_id)
                .map(UserId::new)
                .map_err(|e| anyhow::anyhow!("Invalid user_id UUID: {e}"))
        })
        .transpose()
    }
}
