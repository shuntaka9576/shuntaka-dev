use aws_smithy_http_client::{Connector, proxy::ProxyConfig, tls};
use aws_smithy_runtime_api::client::http::{SharedHttpConnector, http_client_fn};

/// プロキシ環境変数 (HTTPS_PROXY) を反映した SdkConfig をロードする。
///
/// blog-api の Lambda は NAT なしの VPC 内で動くため、AWS API への経路は
/// squid (HTTPS_PROXY) の CONNECT トンネルを通す。SDK のデフォルト HTTP
/// クライアントはプロキシ環境変数を見ない (ProxyConfig::disabled) ので、
/// AWS SDK クライアントを組むときは必ずこの config を使うこと
/// (素の aws_config::defaults().load() で作ると VPC 内から到達できない)。
pub async fn load_sdk_config() -> aws_config::SdkConfig {
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

    aws_config::defaults(aws_config::BehaviorVersion::latest())
        .http_client(http_client)
        .load()
        .await
}
