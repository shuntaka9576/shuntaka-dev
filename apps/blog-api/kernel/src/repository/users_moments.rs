use async_trait::async_trait;

use crate::model::moment::MomentSummary;

#[async_trait]
pub trait UsersMomentsRepository: Send + Sync {
    /// published の moment を published_at の降順（同時刻は moment_id 降順）で返す。
    /// before_moment_id を指定すると、その行より後ろ（= 日付が古い側）だけを返す（カーソルページング）
    async fn find_published_by_user_name(
        &self,
        user_name: &str,
        before_moment_id: Option<&str>,
        limit: u64,
    ) -> Result<Vec<MomentSummary>, anyhow::Error>;
}
