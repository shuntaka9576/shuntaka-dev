use std::sync::Arc;

use adapter::{
    database::ConnectionPool,
    repository::{
        articles::ArticlesRepositoryImpl, health::HealthCheckRepositoryImpl,
        users::UsersRepositoryImpl, users_articles::UsersArticlesRepositoryImpl,
    },
};
use infrastructure::ssm::{ParameterStoreClient, ParameterStoreClientImpl};
use kernel::repository::{
    articles::ArticlesRepository, health::HealthCheckRepository, users::UsersRepository,
    users_articles::UsersArticlesRepository,
};

/// Configuration for webhook processing
#[derive(Clone)]
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

#[derive(Clone)]
pub struct AppRegistry {
    health_check_repository: Arc<dyn HealthCheckRepository>,
    users_articles_repository: Arc<dyn UsersArticlesRepository>,
    articles_repository: Arc<dyn ArticlesRepository>,
    users_repository: Arc<dyn UsersRepository>,
    ssm_client: Arc<dyn ParameterStoreClient>,
    webhook_config: WebhookConfig,
}

impl AppRegistry {
    pub async fn new(pool: ConnectionPool, webhook_config: WebhookConfig) -> Self {
        let health_check_repository = Arc::new(HealthCheckRepositoryImpl::new(pool.clone()));
        let users_articles_repository = Arc::new(UsersArticlesRepositoryImpl::new(pool.clone()));
        let articles_repository = Arc::new(ArticlesRepositoryImpl::new(pool.clone()));
        let users_repository = Arc::new(UsersRepositoryImpl::new(pool.clone()));
        let ssm_client = Arc::new(ParameterStoreClientImpl::new().await);

        Self {
            health_check_repository,
            users_articles_repository,
            articles_repository,
            users_repository,
            ssm_client,
            webhook_config,
        }
    }

    pub fn health_check_repository(&self) -> Arc<dyn HealthCheckRepository> {
        self.health_check_repository.clone()
    }

    pub fn users_articles_repository(&self) -> Arc<dyn UsersArticlesRepository> {
        self.users_articles_repository.clone()
    }

    pub fn articles_repository(&self) -> Arc<dyn ArticlesRepository> {
        self.articles_repository.clone()
    }

    pub fn users_repository(&self) -> Arc<dyn UsersRepository> {
        self.users_repository.clone()
    }

    pub fn ssm_client(&self) -> Arc<dyn ParameterStoreClient> {
        self.ssm_client.clone()
    }

    pub fn webhook_config(&self) -> &WebhookConfig {
        &self.webhook_config
    }
}
