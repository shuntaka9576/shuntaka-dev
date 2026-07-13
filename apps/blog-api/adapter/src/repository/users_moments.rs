use async_trait::async_trait;
use chrono::{DateTime, Utc};
use derive_new::new;
use kernel::model::moment::MomentSummary;
use kernel::repository::users_moments::UsersMomentsRepository;
use sqlx::FromRow;

use crate::database::ConnectionPool;
use crate::observability::observe_query;

#[derive(FromRow)]
struct MomentSummaryRow {
    moment_id: String,
    text: String,
    image_key: String,
    fastener: String,
    fastener_color: Option<String>,
    published_at: DateTime<Utc>,
}

impl From<MomentSummaryRow> for MomentSummary {
    fn from(row: MomentSummaryRow) -> Self {
        MomentSummary {
            moment_id: row.moment_id,
            text: row.text,
            image_key: row.image_key,
            fastener: row.fastener,
            fastener_color: row.fastener_color,
            published_at: row.published_at,
        }
    }
}

// 表示順は published_at の降順（管理画面で日付を過去に変更できるため、作成順の
// ULID ではなく日付で並べる）。同時刻は moment_id 降順でタイブレークする。
// published_at は publish 時に必ず設定されるが、NULL の異常データでも
// 落ちないよう created_at にフォールバックする
const LIST_SQL: &str = "SELECT m.moment_id, m.text, m.image_key, m.fastener, m.fastener_color,\n    \
     COALESCE(m.published_at, m.created_at) AS published_at\n\
     FROM moments m\n\
     WHERE m.user_id = (SELECT user_id FROM users WHERE name = ?)\n  \
     AND m.status = 'published'\n\
     ORDER BY published_at DESC, m.moment_id DESC\n\
     LIMIT ?";

// カーソルは前ページ末尾の moment_id のまま受け、その行の (published_at, moment_id) を
// 行サブクエリで引いてタプル比較する（API 契約を変えずに日付順ページングにする）。
// カーソル行が削除済みの場合はサブクエリが空 → 比較が NULL になり空ページで打ち切られる
const LIST_SQL_WITH_CURSOR: &str = "SELECT m.moment_id, m.text, m.image_key, m.fastener, m.fastener_color,\n    \
     COALESCE(m.published_at, m.created_at) AS published_at\n\
     FROM moments m\n\
     WHERE m.user_id = (SELECT user_id FROM users WHERE name = ?)\n  \
     AND m.status = 'published'\n  \
     AND (COALESCE(m.published_at, m.created_at), m.moment_id) < (\n    \
     SELECT COALESCE(c.published_at, c.created_at), c.moment_id\n    \
     FROM moments c WHERE c.moment_id = ?)\n\
     ORDER BY published_at DESC, m.moment_id DESC\n\
     LIMIT ?";

#[derive(new)]
pub struct UsersMomentsRepositoryImpl {
    db: ConnectionPool,
}

#[async_trait]
impl UsersMomentsRepository for UsersMomentsRepositoryImpl {
    async fn find_published_by_user_name(
        &self,
        user_name: &str,
        before_moment_id: Option<&str>,
        limit: u64,
    ) -> Result<Vec<MomentSummary>, anyhow::Error> {
        let pool = self.db.pool();

        let sql = match before_moment_id {
            Some(_) => LIST_SQL_WITH_CURSOR,
            None => LIST_SQL,
        };
        let mut q = sqlx::query_as::<_, MomentSummaryRow>(sql).bind(user_name);
        if let Some(id) = before_moment_id {
            q = q.bind(id);
        }
        q = q.bind(limit);

        let rows: Vec<MomentSummaryRow> =
            observe_query("moment_list", sql, q.fetch_all(&pool), |rows| {
                Some(rows.len() as i64)
            })
            .await?;

        Ok(rows.into_iter().map(Into::into).collect())
    }
}
