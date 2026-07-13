use async_trait::async_trait;
use aws_sdk_lambda::primitives::Blob;
use aws_sdk_lambda::types::InvocationType;
use aws_smithy_http_client::{Connector, proxy::ProxyConfig, tls};
use aws_smithy_runtime_api::client::http::{SharedHttpConnector, http_client_fn};

use crate::error::LambdaInvokeError;

/// 自分自身の Lambda 関数を非同期 (Event) invoke するためのトレイト。
///
/// GitHub webhook の受付ハンドラーは GitHub 側の 10 秒タイムアウト内に
/// レスポンスを返す必要があるため、実処理は自己 Event invoke に逃がす。
/// invoke されたイベントは Lambda Web Adapter が
/// AWS_LWA_PASS_THROUGH_PATH (POST /events) へ転送してくる。
#[async_trait]
pub trait SelfInvoker: Send + Sync {
    async fn invoke_async(&self, payload: Vec<u8>) -> Result<(), LambdaInvokeError>;
}

pub struct LambdaSelfInvoker {
    client: aws_sdk_lambda::Client,
    function_name: String,
}

impl LambdaSelfInvoker {
    /// Lambda 実行環境 (AWS_LAMBDA_FUNCTION_NAME が設定されている) でのみ Some を返す。
    /// ローカル開発では None になり、呼び出し側はインライン処理へフォールバックする。
    pub async fn from_env() -> Option<Self> {
        let function_name = std::env::var("AWS_LAMBDA_FUNCTION_NAME").ok()?;

        // blog-api の Lambda は NAT なしの VPC 内で動くため、Lambda API への経路は
        // squid (HTTPS_PROXY) の CONNECT トンネルを通す。SDK のデフォルト HTTP
        // クライアントはプロキシ環境変数を見ない (ProxyConfig::disabled) ので、
        // from_env を明示したコネクタを組む。
        let http_client = http_client_fn(|settings, _components| {
            let connector = Connector::builder()
                .proxy_config(ProxyConfig::from_env())
                .connector_settings(settings.clone())
                .tls_provider(tls::Provider::Rustls(
                    tls::rustls_provider::CryptoMode::AwsLc,
                ))
                .build();
            SharedHttpConnector::new(connector)
        });

        let config = aws_config::defaults(aws_config::BehaviorVersion::latest())
            .http_client(http_client)
            .load()
            .await;

        Some(Self {
            client: aws_sdk_lambda::Client::new(&config),
            function_name,
        })
    }
}

#[async_trait]
impl SelfInvoker for LambdaSelfInvoker {
    async fn invoke_async(&self, payload: Vec<u8>) -> Result<(), LambdaInvokeError> {
        self.client
            .invoke()
            .function_name(&self.function_name)
            .invocation_type(InvocationType::Event)
            .payload(Blob::new(payload))
            .send()
            .await
            .map_err(|e| LambdaInvokeError::Sdk(e.to_string()))?;
        Ok(())
    }
}
