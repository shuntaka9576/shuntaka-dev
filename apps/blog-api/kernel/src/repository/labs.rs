use async_trait::async_trait;

use crate::model::article::UserId;
use crate::model::lab::LabId;

/// labs upsert の入力。slug (user_id, slug) で既存判定する。
#[derive(Debug, Clone)]
pub struct UpsertLabInput {
    pub user_id: UserId,
    pub slug: String,
    pub title: String,
    pub summary: Option<String>,
    pub published: bool,
}

/// lab_chapters upsert の入力。(lab_id, slug) で既存判定する。
#[derive(Debug, Clone)]
pub struct UpsertChapterInput {
    pub lab_id: LabId,
    pub slug: String,
    pub title: String,
    /// config.yaml の chapters 配列の添字 (0 始まり)
    pub position: i32,
    pub content: String,
    /// 事前生成した変換済み HTML。Some なら保存し、None なら既存値を維持する
    /// (articles の UpsertArticleInput.content_html と同じ契約)
    pub content_html: Option<String>,
}

/// lab_chapters 1 行分の同期用ステート。HTML 再生成要否 (content 差分) と
/// 削除対象判定 (リポジトリ側の keep_slugs との差集合) に使う。
#[derive(Debug, Clone)]
pub struct ChapterState {
    pub slug: String,
    pub content: String,
}

#[async_trait]
pub trait LabsRepository: Send + Sync {
    /// slug で既存判定して labs を upsert する。title/summary/published に
    /// 差分がなければ UPDATE をスキップし、既存の lab_id をそのまま返す。
    async fn upsert_lab(&self, input: UpsertLabInput) -> Result<LabId, anyhow::Error>;

    /// lab 配下の既存章一覧 (slug, content)。HTML 再生成要否と削除判定に使う。
    async fn list_chapter_states(&self, lab_id: &LabId)
    -> Result<Vec<ChapterState>, anyhow::Error>;

    /// (lab_id, slug) で章を upsert する。content_html が None なら既存値を維持する。
    async fn upsert_chapter(&self, input: UpsertChapterInput) -> Result<(), anyhow::Error>;

    /// lab 配下で keep_slugs に含まれない章を削除する。
    async fn delete_chapters_not_in(
        &self,
        lab_id: &LabId,
        keep_slugs: &[String],
    ) -> Result<(), anyhow::Error>;

    /// user が持つ lab の slug 一覧 (リポジトリから消えた lab の削除判定に使う)
    async fn list_lab_slugs(&self, user_id: &UserId) -> Result<Vec<String>, anyhow::Error>;

    /// user が持つ lab のうち keep_slugs に含まれないものを、配下の章ごとハード削除する。
    async fn delete_labs_not_in(
        &self,
        user_id: &UserId,
        keep_slugs: &[String],
    ) -> Result<(), anyhow::Error>;
}
