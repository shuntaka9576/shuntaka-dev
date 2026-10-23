use async_trait::async_trait;
use aws_sdk_lambda::primitives::Blob;
use aws_sdk_lambda::types::InvocationType;

use crate::error::LambdaInvokeError;

/// webhook の実処理を担う Event Function を非同期 (Event) invoke するためのトレイト。
///
/// GitHub webhook の受付ハンドラーは GitHub 側の 10 秒タイムアウト内に
/// レスポンスを返す必要があるため、実処理は Event Function への Event invoke に逃がす。
/// HTTP を受ける Web Function は Event invoke を受けられないため、実処理は別関数で行う。
/// invoke されたイベントは Event Function の Lambda Web Adapter が
/// AWS_LWA_PASS_THROUGH_PATH (POST /events) へ転送してくる。
#[async_trait]
pub trait EventInvoker: Send + Sync {
    async fn invoke_async(&self, payload: Vec<u8>) -> Result<(), LambdaInvokeError>;
}

pub struct LambdaEventInvoker {
    client: aws_sdk_lambda::Client,
    function_name: String,
}

impl LambdaEventInvoker {
    /// invoke 先 (EVENT_FUNCTION_NAME) が設定されている環境 (Web Function) でのみ Some を返す。
    /// ローカル開発と Event Function 自身では None になり、呼び出し側はインライン処理へフォールバックする。
    pub async fn from_env() -> Option<Self> {
        let function_name = std::env::var("EVENT_FUNCTION_NAME").ok()?;

        // squid (HTTPS_PROXY) の CONNECT トンネルを通すため proxy 反映済み config を使う
        let config = crate::aws::load_sdk_config().await;

        Some(Self {
            client: aws_sdk_lambda::Client::new(&config),
            function_name,
        })
    }
}

#[async_trait]
impl EventInvoker for LambdaEventInvoker {
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
