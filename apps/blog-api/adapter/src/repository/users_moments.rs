use async_trait::async_trait;
use chrono::NaiveDateTime;
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
    // TZ なしの撮影ローカル日時 (DATETIME をそのまま受ける)
    captured_at: NaiveDateTime,
}

impl From<MomentSummaryRow> for MomentSummary {
    fn from(row: MomentSummaryRow) -> Self {
        MomentSummary {
            moment_id: row.moment_id,
            text: row.text,
            image_key: row.image_key,
            fastener: row.fastener,
            fastener_color: row.fastener_color,
            captured_at: row.captured_at,
        }
    }
}

// 表示順は撮影時刻 captured_at の降順（同時刻は moment_id 降順でタイブレーク）
const LIST_SQL: &str = "SELECT m.moment_id, m.text, m.image_key, m.fastener, m.fastener_color, m.captured_at\n\
     FROM moments m\n\
     WHERE m.user_id = (SELECT user_id FROM users WHERE name = ?)\n  \
     AND m.status = 'published'\n\
     ORDER BY m.captured_at DESC, m.moment_id DESC\n\
     LIMIT ?";

// カーソルは前ページ末尾の (captured_at, moment_id) をそのまま受けてタプル比較する
const LIST_SQL_WITH_CURSOR: &str = "SELECT m.moment_id, m.text, m.image_key, m.fastener, m.fastener_color, m.captured_at\n\
     FROM moments m\n\
     WHERE m.user_id = (SELECT user_id FROM users WHERE name = ?)\n  \
     AND m.status = 'published'\n  \
     AND (m.captured_at, m.moment_id) < (?, ?)\n\
     ORDER BY m.captured_at DESC, m.moment_id DESC\n\
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
        before: Option<(NaiveDateTime, &str)>,
        limit: u64,
    ) -> Result<Vec<MomentSummary>, anyhow::Error> {
        let pool = self.db.pool();

        let sql = match before {
            Some(_) => LIST_SQL_WITH_CURSOR,
            None => LIST_SQL,
        };
        let mut q = sqlx::query_as::<_, MomentSummaryRow>(sql).bind(user_name);
        if let Some((captured_at, moment_id)) = before {
            q = q.bind(captured_at).bind(moment_id);
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
