use async_trait::async_trait;

use crate::model::moment::MomentSummary;

#[async_trait]
pub trait UsersMomentsRepository: Send + Sync {
    /// published の moment を moment_id (ULID) の降順で返す。
    /// before_moment_id を指定すると、それより小さい（= 古い）ものだけを返す（カーソルページング）
    async fn find_published_by_user_name(
        &self,
        user_name: &str,
        before_moment_id: Option<&str>,
        limit: u64,
    ) -> Result<Vec<MomentSummary>, anyhow::Error>;
}
