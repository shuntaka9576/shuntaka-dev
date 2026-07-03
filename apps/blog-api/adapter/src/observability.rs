//! DB アクセスの OTel 計装ヘルパー。
//!
//! リポジトリ層の各 SQL 実行を `observe_query` で包み、クライアント側から見た
//! クエリレイテンシ (`db.query.duration`) と `SELECT 1` ベースライン
//! (`db.healthcheck.duration`) を span + metrics で記録する。
//! TiDB 内部の実行時間 (Statement Summary) との突き合わせでボトルネックが
//! ネットワーク/proxy 側か SQL/TiDB 側かを判別するのが目的。
//!
//! span 属性には生 SQL・バインド値・ユーザー ID 等を入れない。SQL は正規化後の
//! ハッシュ (`db.statement_hash`) と論理名 (`db.query_type`) のみで識別する。

use std::future::Future;
use std::sync::{LazyLock, OnceLock};
use std::time::Instant;

use opentelemetry::KeyValue;
use opentelemetry::global;
use opentelemetry::metrics::{Counter, Histogram};
use sha2::{Digest, Sha256};
use tracing::Instrument;

/// `SELECT 1` ヘルスチェックを示す論理クエリ名。
/// この query_type のときだけ `db.healthcheck` span / metric として記録する。
pub const HEALTHCHECK_QUERY_TYPE: &str = "select_1";

struct DbMeta {
    peer_name: String,
    db_name: String,
}

static DB_META: OnceLock<DbMeta> = OnceLock::new();

/// 接続 URL から net.peer.name / db.name を切り出して保持する。
/// 認証情報は含めない。`connect_database_with` から一度だけ呼ばれる。
pub fn set_db_meta_from_url(url: &str) {
    let (peer_name, db_name) = parse_mysql_url(url);
    let _ = DB_META.set(DbMeta { peer_name, db_name });
}

/// (net.peer.name, db.name) を返す。未設定なら "unknown"。
pub fn db_meta_pair() -> (&'static str, &'static str) {
    DB_META
        .get()
        .map(|m| (m.peer_name.as_str(), m.db_name.as_str()))
        .unwrap_or(("unknown", "unknown"))
}

fn parse_mysql_url(url: &str) -> (String, String) {
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let host_and_path = rest.rsplit_once('@').map(|(_, r)| r).unwrap_or(rest);
    let (host_port, path) = host_and_path.split_once('/').unwrap_or((host_and_path, ""));
    let host = host_port.split(':').next().unwrap_or(host_port);
    let db = path.split('?').next().unwrap_or("");
    (
        if host.is_empty() {
            "unknown".to_string()
        } else {
            host.to_string()
        },
        if db.is_empty() {
            "unknown".to_string()
        } else {
            db.to_string()
        },
    )
}

/// レイテンシ histogram の bucket 境界 (ms)。CloudWatch のパーセンタイルは
/// bucket 境界で量子化されるため、想定レンジ (数 ms 〜 数十秒) を細かめに切る。
fn latency_boundaries() -> Vec<f64> {
    vec![
        1.0, 2.0, 5.0, 10.0, 20.0, 30.0, 50.0, 75.0, 100.0, 150.0, 200.0, 300.0, 500.0, 750.0,
        1000.0, 1500.0, 2000.0, 3000.0, 5000.0, 10000.0, 30000.0,
    ]
}

static QUERY_DURATION: LazyLock<Histogram<f64>> = LazyLock::new(|| {
    global::meter("blog-api")
        .f64_histogram("db.query.duration")
        .with_unit("ms")
        .with_description("Client-side SQL query latency observed from Lambda")
        .with_boundaries(latency_boundaries())
        .build()
});

static HEALTHCHECK_DURATION: LazyLock<Histogram<f64>> = LazyLock::new(|| {
    global::meter("blog-api")
        .f64_histogram("db.healthcheck.duration")
        .with_unit("ms")
        .with_description("SELECT 1 baseline latency (Lambda -> forwarder -> TiDB round trip)")
        .with_boundaries(latency_boundaries())
        .build()
});

static CONNECTION_DURATION: LazyLock<Histogram<f64>> = LazyLock::new(|| {
    global::meter("blog-api")
        .f64_histogram("db.connection.duration")
        .with_unit("ms")
        .with_description("DB connection pool establishment latency")
        .with_boundaries(latency_boundaries())
        .build()
});

static QUERY_ERROR_COUNT: LazyLock<Counter<u64>> = LazyLock::new(|| {
    global::meter("blog-api")
        .u64_counter("db.query.error.count")
        .with_description("DB query error count")
        .build()
});

/// `db.connection.duration` を記録する (接続確立の成否によらず呼ぶ)。
pub fn record_connection_duration(elapsed_ms: f64) {
    CONNECTION_DURATION.record(elapsed_ms, &[]);
}

/// SQL 実行 future を `db.query` (または `db.healthcheck`) span で包み、
/// クライアント側レイテンシを histogram に記録する。
///
/// - `query_type`: `article_list` のような安定した論理名 (低カーディナリティ)
/// - `sql`: 属性用のハッシュ計算にのみ使い、span には生 SQL を入れない
/// - `rows_of`: 成功時の結果から返却行数を取り出す (無ければ `|_| None`)
pub async fn observe_query<T, E, F, R>(
    query_type: &'static str,
    sql: &str,
    fut: F,
    rows_of: R,
) -> Result<T, E>
where
    F: Future<Output = Result<T, E>>,
    E: std::fmt::Display,
    R: FnOnce(&T) -> Option<i64>,
{
    let (peer_name, db_name) = db_meta_pair();
    let operation = sql_operation(sql);
    let statement_hash = statement_hash(sql);
    let is_healthcheck = query_type == HEALTHCHECK_QUERY_TYPE;
    let span_name = if is_healthcheck {
        "db.healthcheck"
    } else {
        "db.query"
    };

    let span = tracing::info_span!(
        "db.query",
        otel.name = span_name,
        otel.kind = "client",
        db.system = "mysql",
        db.name = db_name,
        db.operation = operation,
        db.statement_hash = %statement_hash,
        db.query_type = query_type,
        net.peer.name = peer_name,
        // awsxray exporter は db.connection_string が無いと接続先を localhost に
        // フォールバックするため実ホストを明示する。server.address は新 semconv 用
        server.address = peer_name,
        db.connection_string = peer_name,
        db.rows_returned = tracing::field::Empty,
        otel.status_code = tracing::field::Empty,
        error.message = tracing::field::Empty,
    );

    let start = Instant::now();
    let result = fut.instrument(span.clone()).await;
    let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;

    let attrs = [
        KeyValue::new("db.query_type", query_type),
        KeyValue::new("db.operation", operation),
    ];
    if is_healthcheck {
        HEALTHCHECK_DURATION.record(elapsed_ms, &attrs);
    } else {
        QUERY_DURATION.record(elapsed_ms, &attrs);
    }

    match &result {
        Ok(value) => {
            if let Some(rows) = rows_of(value) {
                span.record("db.rows_returned", rows);
            }
        }
        Err(e) => {
            span.record("otel.status_code", "ERROR");
            span.record("error.message", tracing::field::display(e));
            QUERY_ERROR_COUNT.add(1, &attrs);
        }
    }

    result
}

fn sql_operation(sql: &str) -> &'static str {
    let first = sql
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_ascii_uppercase();
    match first.as_str() {
        "SELECT" => "SELECT",
        "INSERT" => "INSERT",
        "UPDATE" => "UPDATE",
        "DELETE" => "DELETE",
        _ => "OTHER",
    }
}

/// 空白正規化した SQL の SHA-256 先頭 8 バイト。TiDB statement digest との
/// 突き合わせ用の安定した識別子として使う (完全一致は不要、時系列比較が目的)。
fn statement_hash(sql: &str) -> String {
    let normalized = sql.split_whitespace().collect::<Vec<_>>().join(" ");
    let digest = Sha256::digest(normalized.as_bytes());
    format!("sha256:{}", hex::encode(&digest[..8]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_mysql_url_extracts_host_and_db() {
        let (host, db) =
            parse_mysql_url("mysql://root@tidb-proxy.internal:13306/blog_prd?ssl-mode=PREFERRED");
        assert_eq!(host, "tidb-proxy.internal");
        assert_eq!(db, "blog_prd");
    }

    #[test]
    fn parse_mysql_url_without_credentials_and_db() {
        let (host, db) = parse_mysql_url("mysql://localhost:4000");
        assert_eq!(host, "localhost");
        assert_eq!(db, "unknown");
    }

    #[test]
    fn sql_operation_detects_select_with_hint() {
        assert_eq!(sql_operation("SELECT /*+ USE_INDEX(a, i) */ 1"), "SELECT");
        assert_eq!(sql_operation("\n UPDATE articles SET x = 1"), "UPDATE");
    }

    #[test]
    fn statement_hash_is_whitespace_insensitive() {
        assert_eq!(
            statement_hash("SELECT 1\n  FROM t"),
            statement_hash("SELECT 1 FROM t")
        );
    }
}
