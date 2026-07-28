use async_trait::async_trait;
use derive_new::new;
use kernel::model::article::UserId;
use kernel::model::lab::LabId;
use kernel::repository::labs::{ChapterState, LabsRepository, UpsertChapterInput, UpsertLabInput};
use sqlx::FromRow;
use uuid::Uuid;

use crate::database::ConnectionPool;
use crate::observability::observe_query;

#[derive(FromRow)]
struct LabRow {
    lab_id: String,
    title: String,
    summary: Option<String>,
    published: bool,
}

#[derive(FromRow)]
struct ChapterExistsRow {
    chapter_id: String,
}

#[derive(new)]
pub struct LabsRepositoryImpl {
    db: ConnectionPool,
}

#[async_trait]
impl LabsRepository for LabsRepositoryImpl {
    async fn upsert_lab(&self, input: UpsertLabInput) -> Result<LabId, anyhow::Error> {
        let sql =
            "SELECT lab_id, title, summary, published FROM labs WHERE user_id = ? AND slug = ?";
        let existing: Option<LabRow> = observe_query(
            "lab_by_user_and_slug",
            sql,
            sqlx::query_as(sql)
                .bind(input.user_id.as_uuid().to_string())
                .bind(&input.slug)
                .fetch_optional(&self.db.pool()),
            |row| Some(i64::from(row.is_some())),
        )
        .await?;

        match existing {
            Some(row) => {
                let unchanged = row.title == input.title
                    && row.summary == input.summary
                    && row.published == input.published;

                if unchanged {
                    let lab_id = Uuid::parse_str(&row.lab_id)
                        .map_err(|e| anyhow::anyhow!("Invalid lab_id UUID: {e}"))?;
                    return Ok(LabId::new(lab_id));
                }

                let update_sql =
                    "UPDATE labs SET title = ?, summary = ?, published = ? WHERE lab_id = ?";
                observe_query(
                    "lab_update",
                    update_sql,
                    sqlx::query(update_sql)
                        .bind(&input.title)
                        .bind(&input.summary)
                        .bind(input.published)
                        .bind(&row.lab_id)
                        .execute(&self.db.pool()),
                    |res| Some(res.rows_affected() as i64),
                )
                .await?;

                let lab_id = Uuid::parse_str(&row.lab_id)
                    .map_err(|e| anyhow::anyhow!("Invalid lab_id UUID: {e}"))?;
                Ok(LabId::new(lab_id))
            }
            None => {
                let lab_id = Uuid::new_v4();
                let insert_sql = r#"
                    INSERT INTO labs (lab_id, user_id, slug, title, summary, published)
                    VALUES (?, ?, ?, ?, ?, ?)
                    "#;
                observe_query(
                    "lab_insert",
                    insert_sql,
                    sqlx::query(insert_sql)
                        .bind(lab_id.to_string())
                        .bind(input.user_id.as_uuid().to_string())
                        .bind(&input.slug)
                        .bind(&input.title)
                        .bind(&input.summary)
                        .bind(input.published)
                        .execute(&self.db.pool()),
                    |res| Some(res.rows_affected() as i64),
                )
                .await?;

                Ok(LabId::new(lab_id))
            }
        }
    }

    async fn list_chapter_states(
        &self,
        lab_id: &LabId,
    ) -> Result<Vec<ChapterState>, anyhow::Error> {
        let sql = "SELECT slug, content FROM lab_chapters WHERE lab_id = ?";
        let rows: Vec<(String, String)> = observe_query(
            "lab_chapters_by_lab_id",
            sql,
            sqlx::query_as(sql)
                .bind(lab_id.as_uuid().to_string())
                .fetch_all(&self.db.pool()),
            |rows| Some(rows.len() as i64),
        )
        .await?;

        Ok(rows
            .into_iter()
            .map(|(slug, content)| ChapterState { slug, content })
            .collect())
    }

    async fn upsert_chapter(&self, input: UpsertChapterInput) -> Result<(), anyhow::Error> {
        let lab_id_str = input.lab_id.as_uuid().to_string();

        let find_sql = "SELECT chapter_id FROM lab_chapters WHERE lab_id = ? AND slug = ?";
        let existing: Option<ChapterExistsRow> = observe_query(
            "lab_chapter_by_lab_and_slug",
            find_sql,
            sqlx::query_as(find_sql)
                .bind(&lab_id_str)
                .bind(&input.slug)
                .fetch_optional(&self.db.pool()),
            |row| Some(i64::from(row.is_some())),
        )
        .await?;

        match existing {
            Some(row) => {
                // content_html が None のときは COALESCE で既存値を維持する
                // (articles の upsert と同じ契約)
                let update_sql = r#"
                    UPDATE lab_chapters
                    SET title = ?, position = ?, content = ?, content_html = COALESCE(?, content_html)
                    WHERE chapter_id = ?
                    "#;
                observe_query(
                    "lab_chapter_update",
                    update_sql,
                    sqlx::query(update_sql)
                        .bind(&input.title)
                        .bind(input.position)
                        .bind(&input.content)
                        .bind(&input.content_html)
                        .bind(&row.chapter_id)
                        .execute(&self.db.pool()),
                    |res| Some(res.rows_affected() as i64),
                )
                .await?;
            }
            None => {
                let chapter_id = Uuid::new_v4().to_string();
                let insert_sql = r#"
                    INSERT INTO lab_chapters (chapter_id, lab_id, slug, title, position, content, content_html)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    "#;
                observe_query(
                    "lab_chapter_insert",
                    insert_sql,
                    sqlx::query(insert_sql)
                        .bind(&chapter_id)
                        .bind(&lab_id_str)
                        .bind(&input.slug)
                        .bind(&input.title)
                        .bind(input.position)
                        .bind(&input.content)
                        .bind(&input.content_html)
                        .execute(&self.db.pool()),
                    |res| Some(res.rows_affected() as i64),
                )
                .await?;
            }
        }

        Ok(())
    }

    async fn delete_chapters_not_in(
        &self,
        lab_id: &LabId,
        keep_slugs: &[String],
    ) -> Result<(), anyhow::Error> {
        let lab_id_str = lab_id.as_uuid().to_string();

        if keep_slugs.is_empty() {
            let sql = "DELETE FROM lab_chapters WHERE lab_id = ?";
            observe_query(
                "lab_chapters_delete_all",
                sql,
                sqlx::query(sql).bind(&lab_id_str).execute(&self.db.pool()),
                |res| Some(res.rows_affected() as i64),
            )
            .await?;
            return Ok(());
        }

        let placeholders = keep_slugs
            .iter()
            .map(|_| "?")
            .collect::<Vec<_>>()
            .join(", ");
        let sql =
            format!("DELETE FROM lab_chapters WHERE lab_id = ? AND slug NOT IN ({placeholders})");
        let mut query = sqlx::query(sqlx::AssertSqlSafe(sql.as_str())).bind(&lab_id_str);
        for slug in keep_slugs {
            query = query.bind(slug);
        }
        observe_query(
            "lab_chapters_delete_not_in",
            &sql,
            query.execute(&self.db.pool()),
            |res| Some(res.rows_affected() as i64),
        )
        .await?;

        Ok(())
    }

    async fn list_lab_slugs(&self, user_id: &UserId) -> Result<Vec<String>, anyhow::Error> {
        let sql = "SELECT slug FROM labs WHERE user_id = ?";
        let rows: Vec<(String,)> = observe_query(
            "lab_slugs_by_user_id",
            sql,
            sqlx::query_as(sql)
                .bind(user_id.as_uuid().to_string())
                .fetch_all(&self.db.pool()),
            |rows| Some(rows.len() as i64),
        )
        .await?;

        Ok(rows.into_iter().map(|(slug,)| slug).collect())
    }

    async fn delete_labs_not_in(
        &self,
        user_id: &UserId,
        keep_slugs: &[String],
    ) -> Result<(), anyhow::Error> {
        let user_id_str = user_id.as_uuid().to_string();

        // labs / lab_chapters は FK なし・アプリ層整合の方針のため、
        // 章 → 本の順にトランザクションで削除する。
        let mut tx = self.db.pool().begin().await?;

        if keep_slugs.is_empty() {
            sqlx::query(
                "DELETE lc FROM lab_chapters lc JOIN labs l ON l.lab_id = lc.lab_id WHERE l.user_id = ?",
            )
            .bind(&user_id_str)
            .execute(&mut *tx)
            .await?;

            sqlx::query("DELETE FROM labs WHERE user_id = ?")
                .bind(&user_id_str)
                .execute(&mut *tx)
                .await?;
        } else {
            let placeholders = keep_slugs
                .iter()
                .map(|_| "?")
                .collect::<Vec<_>>()
                .join(", ");

            let delete_chapters_sql = format!(
                "DELETE lc FROM lab_chapters lc JOIN labs l ON l.lab_id = lc.lab_id \
                 WHERE l.user_id = ? AND l.slug NOT IN ({placeholders})"
            );
            let mut delete_chapters =
                sqlx::query(sqlx::AssertSqlSafe(delete_chapters_sql.as_str())).bind(&user_id_str);
            for slug in keep_slugs {
                delete_chapters = delete_chapters.bind(slug);
            }
            delete_chapters.execute(&mut *tx).await?;

            let delete_labs_sql =
                format!("DELETE FROM labs WHERE user_id = ? AND slug NOT IN ({placeholders})");
            let mut delete_labs =
                sqlx::query(sqlx::AssertSqlSafe(delete_labs_sql.as_str())).bind(&user_id_str);
            for slug in keep_slugs {
                delete_labs = delete_labs.bind(slug);
            }
            delete_labs.execute(&mut *tx).await?;
        }

        tx.commit().await?;

        Ok(())
    }
}
