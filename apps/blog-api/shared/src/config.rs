use anyhow::Result;

pub struct AppConfig {
    pub database: DatabaseConfig,
    pub server: ServerConfig,
    pub webhook: WebhookConfig,
}

impl AppConfig {
    pub fn new() -> Result<Self> {
        let database = DatabaseConfig {
            url: std::env::var("DATABASE_URL")?,
        };

        let port = std::env::var("PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(8080);

        let server = ServerConfig { port };

        let webhook = WebhookConfig {
            github_app_id: std::env::var("GH_APP_ID").unwrap_or_default(),
            github_app_secret_pem_key_name: std::env::var("GH_APP_SECRET_PEM_KEY_NAME")
                .unwrap_or_default(),
            github_webhook_secret_key_name: std::env::var("GH_WEBHOOK_SECRET_KEY_NAME")
                .unwrap_or_default(),
            articles_dir: std::env::var("ARTICLES_DIR").unwrap_or_else(|_| "articles".to_string()),
            cloudinary_cloud_name: std::env::var("CLOUDINARY_CLOUD_NAME").unwrap_or_default(),
            cloudinary_api_key: std::env::var("CLOUDINARY_API_KEY").unwrap_or_default(),
            cloudinary_api_secret_key_name: std::env::var("CLOUDINARY_API_SECRET_KEY_NAME")
                .unwrap_or_default(),
            ogp_public_id: std::env::var("OGP_PUBLIC_ID")
                .unwrap_or_else(|_| "blog/og/ogp".to_string()),
        };

        Ok(Self {
            database,
            server,
            webhook,
        })
    }
}

pub struct DatabaseConfig {
    /// MySQL/TiDB 接続 URL。例: mysql://root@tidb.<TAILNET>:4000/blog_dev
    pub url: String,
}

pub struct ServerConfig {
    pub port: u16,
}

pub struct WebhookConfig {
    pub github_app_id: String,
    pub github_app_secret_pem_key_name: String,
    pub github_webhook_secret_key_name: String,
    pub articles_dir: String,
    pub cloudinary_cloud_name: String,
    pub cloudinary_api_key: String,
    pub cloudinary_api_secret_key_name: String,
    pub ogp_public_id: String,
}
