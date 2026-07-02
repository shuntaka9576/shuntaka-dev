use anyhow::Result;
use shared::config::DatabaseConfig;
use sqlx::MySqlPool;
use sqlx::mysql::MySqlPoolOptions;

#[derive(Clone)]
pub struct ConnectionPool {
    pool: MySqlPool,
}

impl ConnectionPool {
    pub fn pool(&self) -> MySqlPool {
        self.pool.clone()
    }
}

/// TiDB (MySQL 互換) 接続プールを作る。
///
/// 接続先は `cfg.url` (例: `mysql://root@tidb.<TAILNET>:4000/blog_dev`) で指定する。
/// database 名を URL に含めるため、リポジトリ層の SQL では `FROM users` のように
/// スキーマ無しで書き、`blog_dev` / `blog_prod` の切り替えは URL 一行で行う。
///
/// Tailscale 接続前提:
/// - ローカル / EC2 / コンテナ: 既に Tailscale CLI / daemon が常駐し、
///   `tidb.<TAILNET>` が名前解決可能な前提。本関数は **そのまま** TCP 接続するだけ。
/// - Lambda: ランタイムは Tailnet に居ないため、本関数を呼ぶ **前** に Tailscale
///   への参加処理 (tsnet 相当) を済ませる必要がある。`ensure_tailnet_ready()` を
///   差し込み点として用意してあり、Lambda 起動時にここを差し替える。
pub async fn connect_database_with(cfg: &DatabaseConfig) -> Result<ConnectionPool> {
    ensure_tailnet_ready().await?;

    let pool = MySqlPoolOptions::new()
        .max_connections(10)
        .connect(&cfg.url)
        .await?;

    Ok(ConnectionPool { pool })
}

/// Tailnet への参加を保証する。
///
/// 現状はローカル / EC2 / コンテナ実行を想定し no-op。
///
/// TODO(tailscale-on-lambda): Tailscale OAuth クライアント (client_id / secret) が
/// 払い出され次第、`infrastructure` 層に `TailnetClient` を実装し、Lambda の
/// `main` から本関数を差し替え可能にする。設計の選択肢:
///   a) `connect_database_with` 呼び出し前に `TailnetClient::login()` を行い、
///      `tidb.<TAILNET>` を名前解決できる状態にする。
///   b) `tailscale-rs` 等のクレートが安定したら、ここで `Tsnet::up()` を呼ぶ。
async fn ensure_tailnet_ready() -> Result<()> {
    Ok(())
}
