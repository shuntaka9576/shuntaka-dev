use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderName, HeaderValue, header},
};
use chrono::{DateTime, NaiveDateTime};
use kernel::model::moment::MomentSummary;
use registry::AppRegistry;
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use crate::error::AppError;

const DEFAULT_LIMIT: u64 = 20;
const MAX_LIMIT: u64 = 50;

// 公開済み moment しか返さない API のため、CDN / ブラウザ双方でキャッシュを許可する
const CACHE_CONTROL_PUBLIC: (HeaderName, HeaderValue) = (
    header::CACHE_CONTROL,
    HeaderValue::from_static("public, max-age=60, stale-while-revalidate=300"),
);

#[derive(Debug, Deserialize, IntoParams)]
pub struct UsersMomentsQuery {
    /// Cursor for pagination: the `nextCursor` value of the previous page
    /// (`<capturedAt unix micros>_<momentId>`). Omit to fetch from the newest.
    pub cursor: Option<String>,
    /// Number of moments per page (1-50, default 20).
    pub limit: Option<u64>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[schema(rename_all = "camelCase")]
pub struct MomentSummaryResponse {
    /// ULID (26 chars)
    pub moment_id: String,
    /// 180 文字以内の一文
    pub text: String,
    /// orig 画像の配信 URL
    pub image_url: String,
    /// 一覧表示用サムネイル（長辺 640px）の配信 URL
    pub thumb_url: String,
    /// 'clip' | 'tape'
    pub fastener: String,
    /// tape のみ有効。'pink' | 'blue' | 'yellow' | 'green'
    pub fastener_color: Option<String>,
    /// 撮影時刻 (TZ なしのローカル日時 YYYY-MM-DDTHH:mm:ss)。
    /// EXIF 同様に撮影地の壁時計として TZ 変換せず表示する
    pub captured_at: String,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[schema(rename_all = "camelCase")]
pub struct UsersMomentsResponse {
    pub moments: Vec<MomentSummaryResponse>,
    /// 次ページ取得用カーソル。null で末尾
    pub next_cursor: Option<String>,
}

// ─────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────

/// ULID (Crockford Base32、I/L/O/U を除く大文字英数 26 文字) かどうか
fn is_valid_moment_id(s: &str) -> bool {
    s.len() == 26
        && s.bytes().all(|b| {
            matches!(b, b'0'..=b'9' | b'A'..=b'H' | b'J' | b'K' | b'M' | b'N' | b'P'..=b'T' | b'V'..=b'Z')
        })
}

/// カーソル文字列 `<captured_at micros>_<moment_id>` を分解する。
/// adapter 側でこのタプルとの比較だけでページングできるようにする。
/// captured_at は TZ なしの壁時計のため、micros は epoch からの経過ではなく
/// 「壁時計を UTC とみなした値」として往復させる
fn parse_cursor(raw: &str) -> Option<(NaiveDateTime, &str)> {
    let (micros_raw, moment_id) = raw.split_once('_')?;
    if !is_valid_moment_id(moment_id) {
        return None;
    }
    let micros: i64 = micros_raw.parse().ok()?;
    let captured_at = DateTime::from_timestamp_micros(micros)?.naive_utc();
    Some((captured_at, moment_id))
}

/// 次ページ用カーソルを組み立てる（parse_cursor と対）。
/// captured_at は DATETIME(6) のためマイクロ秒精度で正確に往復できる
fn encode_cursor(moment: &MomentSummary) -> String {
    format!(
        "{}_{}",
        moment.captured_at.and_utc().timestamp_micros(),
        moment.moment_id
    )
}

fn parse_limit(raw: Option<u64>) -> Result<u64, AppError> {
    let Some(value) = raw else {
        return Ok(DEFAULT_LIMIT);
    };
    if value == 0 {
        return Err(AppError::bad_request("limit must be >= 1"));
    }
    if value > MAX_LIMIT {
        return Err(AppError::bad_request("limit exceeds maximum"));
    }
    Ok(value)
}

/// orig の image_key（"images/moments/<ulid>.webp"）から orig / thumb の配信 URL を組み立てる。
/// thumb は拡張子の手前に "_thumb" を挟んだ key（admin のアップロード仕様と対）
fn build_image_urls(images_base_url: &str, image_key: &str) -> (String, String) {
    let base = images_base_url.trim_end_matches('/');
    let thumb_key = match image_key.rsplit_once('.') {
        Some((stem, ext)) => format!("{stem}_thumb.{ext}"),
        None => format!("{image_key}_thumb"),
    };
    (format!("{base}/{image_key}"), format!("{base}/{thumb_key}"))
}

// ─────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────

#[utoipa::path(
    get,
    path = "/users/{name}/moments",
    params(
        ("name" = String, Path, description = "User name"),
        UsersMomentsQuery,
    ),
    responses(
        (status = 200, description = "Moment list retrieved successfully", body = UsersMomentsResponse),
        (status = 400, description = "Invalid cursor or limit"),
        (status = 500, description = "Internal server error")
    ),
    tag = "users_moments"
)]
pub async fn get_users_moments(
    State(registry): State<AppRegistry>,
    Path(name): Path<String>,
    Query(query): Query<UsersMomentsQuery>,
) -> Result<([(HeaderName, HeaderValue); 1], Json<UsersMomentsResponse>), AppError> {
    let limit = parse_limit(query.limit)?;
    let cursor = match query.cursor.as_deref() {
        None => None,
        Some(c) => match parse_cursor(c) {
            Some(parsed) => Some(parsed),
            None => return Err(AppError::bad_request("Invalid cursor")),
        },
    };

    // limit+1 件取得して次ページの有無を判定する
    let mut moments = registry
        .users_moments_repository()
        .find_published_by_user_name(&name, cursor, limit + 1)
        .await
        .map_err(|e| AppError::internal("Failed to find moments", e))?;

    let has_more = moments.len() as u64 > limit;
    if has_more {
        moments.truncate(limit as usize);
    }
    let next_cursor = if has_more {
        moments.last().map(encode_cursor)
    } else {
        None
    };

    let images_base_url = &registry.webhook_config().images_base_url;
    let response = UsersMomentsResponse {
        moments: moments
            .into_iter()
            .map(|m| {
                let (image_url, thumb_url) = build_image_urls(images_base_url, &m.image_key);
                MomentSummaryResponse {
                    moment_id: m.moment_id,
                    text: m.text,
                    image_url,
                    thumb_url,
                    fastener: m.fastener,
                    fastener_color: m.fastener_color,
                    captured_at: m.captured_at.format("%Y-%m-%dT%H:%M:%S").to_string(),
                }
            })
            .collect(),
        next_cursor,
    };

    Ok(([CACHE_CONTROL_PUBLIC], Json(response)))
}

// ─────────────────────────────────────────
// Unit tests
// ─────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // 26 文字の ULID 形式ダミー ID（数字のみなら Crockford Base32 の範囲内）
    const VALID_ID: &str = "01234567890123456789012345";

    #[test]
    fn is_valid_moment_id_accepts_ulid() {
        assert!(is_valid_moment_id(VALID_ID));
        // cspell:disable-next-line
        assert!(is_valid_moment_id("0123456789ABCDEFGHJKMNPQRS"));
    }

    #[test]
    fn is_valid_moment_id_rejects_wrong_length() {
        assert!(!is_valid_moment_id(""));
        assert!(!is_valid_moment_id(&VALID_ID[..25]));
        assert!(!is_valid_moment_id(&format!("{VALID_ID}0")));
    }

    #[test]
    fn is_valid_moment_id_rejects_lowercase_and_excluded_chars() {
        // 小文字
        assert!(!is_valid_moment_id(&format!("{}a", &VALID_ID[..25])));
        // Crockford Base32 で除外されている I / L / O / U
        for c in ['I', 'L', 'O', 'U'] {
            assert!(!is_valid_moment_id(&format!("{}{c}", &VALID_ID[..25])));
        }
    }

    #[test]
    fn parse_cursor_roundtrips_with_encode_cursor() {
        let moment = MomentSummary {
            moment_id: VALID_ID.to_string(),
            text: "t".to_string(),
            image_key: "images/moments/a.webp".to_string(),
            fastener: "clip".to_string(),
            fastener_color: None,
            captured_at: DateTime::from_timestamp_micros(1_752_300_000_123_456)
                .unwrap()
                .naive_utc(),
        };
        let cursor = encode_cursor(&moment);
        let (captured_at, moment_id) = parse_cursor(&cursor).unwrap();
        assert_eq!(captured_at, moment.captured_at);
        assert_eq!(moment_id, moment.moment_id);
    }

    #[test]
    fn parse_cursor_rejects_malformed() {
        // 区切りなし / micros が数値でない / moment_id が ULID 形式でない
        assert!(parse_cursor(VALID_ID).is_none());
        assert!(parse_cursor(&format!("abc_{VALID_ID}")).is_none());
        assert!(parse_cursor(&format!("123_{}", &VALID_ID[..25])).is_none());
        assert!(parse_cursor("123_").is_none());
        assert!(parse_cursor("").is_none());
    }

    #[test]
    fn parse_limit_defaults() {
        assert_eq!(parse_limit(None).unwrap(), DEFAULT_LIMIT);
    }

    #[test]
    fn parse_limit_accepts_max() {
        assert_eq!(parse_limit(Some(50)).unwrap(), 50);
    }

    #[test]
    fn parse_limit_zero_is_error() {
        assert!(parse_limit(Some(0)).is_err());
    }

    #[test]
    fn parse_limit_over_max_is_error() {
        assert!(parse_limit(Some(51)).is_err());
    }

    #[test]
    fn build_image_urls_inserts_thumb_suffix() {
        let (image_url, thumb_url) = build_image_urls(
            "https://images.shuntaka.tech",
            &format!("images/moments/{VALID_ID}.webp"),
        );
        assert_eq!(
            image_url,
            format!("https://images.shuntaka.tech/images/moments/{VALID_ID}.webp")
        );
        assert_eq!(
            thumb_url,
            format!("https://images.shuntaka.tech/images/moments/{VALID_ID}_thumb.webp")
        );
    }

    #[test]
    fn build_image_urls_trims_trailing_slash() {
        let (image_url, _) =
            build_image_urls("https://images.shuntaka.tech/", "images/moments/a.webp");
        assert_eq!(
            image_url,
            "https://images.shuntaka.tech/images/moments/a.webp"
        );
    }

    #[test]
    fn build_image_urls_without_extension() {
        let (_, thumb_url) = build_image_urls("https://images.example.com", "images/moments/a");
        assert_eq!(
            thumb_url,
            "https://images.example.com/images/moments/a_thumb"
        );
    }
}
