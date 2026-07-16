use std::sync::Arc;

use adapter::{
    database::ConnectionPool,
    repository::{
        articles::ArticlesRepositoryImpl, health::HealthCheckRepositoryImpl,
        users::UsersRepositoryImpl, users_articles::UsersArticlesRepositoryImpl,
        users_moments::UsersMomentsRepositoryImpl,
    },
};
use infrastructure::{embedding::client::EmbeddingClient, lambda::SelfInvoker};
use kernel::repository::{
    articles::ArticlesRepository, health::HealthCheckRepository, users::UsersRepository,
    users_articles::UsersArticlesRepository, users_moments::UsersMomentsRepository,
};

/// Configuration for webhook processing
#[derive(Clone)]
pub struct WebhookConfig {
    pub github_app_id: String,
    pub github_app_secret_pem: String,
    pub github_webhook_secret: String,
    pub articles_dir: String,
    pub cloudinary_cloud_name: String,
    pub cloudinary_api_key: String,
    pub cloudinary_api_secret: String,
    pub ogp_public_id: String,
    /// moments 画像の配信ベース URL（例: https://images.shuntaka.dev）
    pub images_base_url: String,
}

#[derive(Clone)]
pub struct AppRegistry {
    health_check_repository: Arc<dyn HealthCheckRepository>,
    users_articles_repository: Arc<dyn UsersArticlesRepository>,
    users_moments_repository: Arc<dyn UsersMomentsRepository>,
    articles_repository: Arc<dyn ArticlesRepository>,
    users_repository: Arc<dyn UsersRepository>,
    webhook_config: WebhookConfig,
    /// Lambda 実行環境でのみ Some。webhook の実処理を自己 Event invoke に逃がすために使う。
    self_invoker: Option<Arc<dyn SelfInvoker>>,
    /// PLaMOへの到達経路がある環境でのみSome。未設定でも検索以外のAPIは起動する。
    embedding_client: Option<Arc<dyn EmbeddingClient>>,
}

impl AppRegistry {
    pub async fn new(
        pool: ConnectionPool,
        webhook_config: WebhookConfig,
        self_invoker: Option<Arc<dyn SelfInvoker>>,
        embedding_client: Option<Arc<dyn EmbeddingClient>>,
    ) -> Self {
        let health_check_repository = Arc::new(HealthCheckRepositoryImpl::new(pool.clone()));
        let users_articles_repository = Arc::new(UsersArticlesRepositoryImpl::new(pool.clone()));
        let users_moments_repository = Arc::new(UsersMomentsRepositoryImpl::new(pool.clone()));
        let articles_repository = Arc::new(ArticlesRepositoryImpl::new(pool.clone()));
        let users_repository = Arc::new(UsersRepositoryImpl::new(pool.clone()));

        Self {
            health_check_repository,
            users_articles_repository,
            users_moments_repository,
            articles_repository,
            users_repository,
            webhook_config,
            self_invoker,
            embedding_client,
        }
    }

    pub fn health_check_repository(&self) -> Arc<dyn HealthCheckRepository> {
        self.health_check_repository.clone()
    }

    pub fn users_articles_repository(&self) -> Arc<dyn UsersArticlesRepository> {
        self.users_articles_repository.clone()
    }

    pub fn users_moments_repository(&self) -> Arc<dyn UsersMomentsRepository> {
        self.users_moments_repository.clone()
    }

    pub fn articles_repository(&self) -> Arc<dyn ArticlesRepository> {
        self.articles_repository.clone()
    }

    pub fn users_repository(&self) -> Arc<dyn UsersRepository> {
        self.users_repository.clone()
    }

    pub fn webhook_config(&self) -> &WebhookConfig {
        &self.webhook_config
    }

    pub fn self_invoker(&self) -> Option<Arc<dyn SelfInvoker>> {
        self.self_invoker.clone()
    }

    pub fn embedding_client(&self) -> Option<Arc<dyn EmbeddingClient>> {
        self.embedding_client.clone()
    }
}
