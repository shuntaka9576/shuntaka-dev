use async_trait::async_trait;
use chrono::{DateTime, Utc};

use crate::model::moment::MomentSummary;

#[async_trait]
pub trait UsersMomentsRepository: Send + Sync {
    /// published の moment を captured_at の降順（同時刻は moment_id 降順）で返す。
    /// before に前ページ末尾の (captured_at, moment_id) を指定すると、
    /// それより古い側だけを返す（カーソルページング）
    async fn find_published_by_user_name(
        &self,
        user_name: &str,
        before: Option<(DateTime<Utc>, &str)>,
        limit: u64,
    ) -> Result<Vec<MomentSummary>, anyhow::Error>;
}
