use async_trait::async_trait;

use crate::model::article::UserId;

#[async_trait]
pub trait UsersRepository: Send + Sync {
    /// Find user by GitHub installation ID
    async fn find_by_installation_id(
        &self,
        installation_id: i64,
    ) -> Result<Option<UserId>, anyhow::Error>;
}
