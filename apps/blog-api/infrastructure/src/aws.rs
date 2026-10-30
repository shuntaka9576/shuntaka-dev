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

#[cfg(test)]
mod tests {
    use super::*;
    use aws_smithy_runtime_api::client::http::HttpConnector;
    use aws_smithy_runtime_api::client::orchestrator::HttpRequest;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// 本番と同じ rustls-aws-lc コネクタが HTTP リクエストを完走できること。
    /// legacy rustls 0.21 を外した後も、このコネクタが SDK の送信経路になる。
    #[tokio::test]
    async fn rustls_aws_lc_connector_completes_local_http_request() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = [0_u8; 2048];
            let _ = socket.read(&mut buf).await.unwrap();
            let body = b"ok";
            let headers = format!(
                "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            );
            socket.write_all(headers.as_bytes()).await.unwrap();
            socket.write_all(body).await.unwrap();
        });

        let connector = Connector::builder()
            .proxy_config(ProxyConfig::from_env())
            .tls_provider(tls::Provider::Rustls(
                tls::rustls_provider::CryptoMode::AwsLc,
            ))
            .build();
        let response = connector
            .call(HttpRequest::get(format!("http://{addr}/")).unwrap())
            .await
            .expect("rustls-aws-lc connector request");

        assert_eq!(response.status().as_u16(), 200);
    }
}
