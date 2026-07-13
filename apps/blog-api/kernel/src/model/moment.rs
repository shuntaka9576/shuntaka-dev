use chrono::NaiveDateTime;

/// 公開フィード用の moment（180 字 + 写真必須の一文投稿）1 件分。
/// fastener / fastener_color は DB の ENUM 値をそのまま保持する
#[derive(Debug, Clone)]
pub struct MomentSummary {
    /// ULID (26 文字)
    pub moment_id: String,
    /// 180 文字以内の一文
    pub text: String,
    /// orig 画像の key（例: "images/moments/<ulid>.webp"。thumb は "_thumb" サフィックスで導出）
    pub image_key: String,
    /// 'clip' | 'tape'
    pub fastener: String,
    /// tape のみ有効。'pink' | 'blue' | 'yellow' | 'green'
    pub fastener_color: Option<String>,
    /// 撮影時刻。クライアントが EXIF から補完して登録する。
    /// EXIF 同様 TZ を持たない撮影地の壁時計として扱う (DATETIME をそのまま持つ)
    pub captured_at: NaiveDateTime,
}
