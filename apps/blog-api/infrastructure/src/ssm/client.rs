use async_trait::async_trait;
use aws_sdk_ssm::Client as SsmClient;

use crate::error::SsmError;

#[async_trait]
pub trait ParameterStoreClient: Send + Sync {
    async fn get_parameter(&self, name: &str, with_decryption: bool) -> Result<String, SsmError>;
}

pub struct ParameterStoreClientImpl {
    client: SsmClient,
}

impl ParameterStoreClientImpl {
    pub async fn new() -> Self {
        let config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
        Self {
            client: SsmClient::new(&config),
        }
    }

    pub fn new_with_client(client: SsmClient) -> Self {
        Self { client }
    }
}

#[async_trait]
impl ParameterStoreClient for ParameterStoreClientImpl {
    async fn get_parameter(&self, name: &str, with_decryption: bool) -> Result<String, SsmError> {
        let response = self
            .client
            .get_parameter()
            .name(name)
            .with_decryption(with_decryption)
            .send()
            .await
            .map_err(|e| {
                tracing::error!("SSM GetParameter failed: name={}, error={:?}", name, e);
                SsmError::Sdk("Failed to retrieve parameter".to_string())
            })?;

        response
            .parameter
            .and_then(|p| p.value)
            .ok_or_else(|| SsmError::ParameterNotFound(name.to_string()))
    }
}
