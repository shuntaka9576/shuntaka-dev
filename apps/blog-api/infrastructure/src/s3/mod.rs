use async_trait::async_trait;
use aws_sdk_s3::error::SdkError;
use aws_sdk_s3::primitives::ByteStream;

use crate::error::S3Error;

/// lab 教材画像を S3 に同期するためのトレイト。
///
/// 実装 (S3LabImageStore) は Lambda 実行環境でのみ初期化され、ローカル開発では
/// None として扱われ画像同期はスキップされる (lambda::SelfInvoker と同じパターン)。
#[async_trait]
pub trait LabImageStore: Send + Sync {
    /// オブジェクトのメタデータ `github-sha` を返す。オブジェクトが存在しなければ None。
    async fn head_github_sha(&self, bucket: &str, key: &str) -> Result<Option<String>, S3Error>;

    /// メタデータ `github-sha` 付きで画像を PutObject する。
    async fn put_image(
        &self,
        bucket: &str,
        key: &str,
        bytes: Vec<u8>,
        content_type: &str,
        github_sha: &str,
    ) -> Result<(), S3Error>;
}

pub struct S3LabImageStore {
    client: aws_sdk_s3::Client,
}

impl S3LabImageStore {
    /// Lambda 実行環境 (AWS_LAMBDA_FUNCTION_NAME が設定されている) でのみ Some を返す。
    /// ローカル開発では None になり、呼び出し側は画像同期をスキップする。
    pub async fn from_env() -> Option<Self> {
        std::env::var("AWS_LAMBDA_FUNCTION_NAME").ok()?;

        // squid (HTTPS_PROXY) の CONNECT トンネルを通すため proxy 反映済み config を使う。
        // 素の defaults().load() だと VPC 内から S3 に到達できず head/put が失敗する
        let config = crate::aws::load_sdk_config().await;

        Some(Self {
            client: aws_sdk_s3::Client::new(&config),
        })
    }
}

#[async_trait]
impl LabImageStore for S3LabImageStore {
    async fn head_github_sha(&self, bucket: &str, key: &str) -> Result<Option<String>, S3Error> {
        match self
            .client
            .head_object()
            .bucket(bucket)
            .key(key)
            .send()
            .await
        {
            Ok(output) => Ok(output
                .metadata()
                .and_then(|metadata| metadata.get("github-sha"))
                .cloned()),
            Err(SdkError::ServiceError(ctx)) if ctx.err().is_not_found() => Ok(None),
            Err(e) => Err(S3Error::Sdk(e.to_string())),
        }
    }

    async fn put_image(
        &self,
        bucket: &str,
        key: &str,
        bytes: Vec<u8>,
        content_type: &str,
        github_sha: &str,
    ) -> Result<(), S3Error> {
        self.client
            .put_object()
            .bucket(bucket)
            .key(key)
            .body(ByteStream::from(bytes))
            .content_type(content_type)
            .metadata("github-sha", github_sha)
            .send()
            .await
            .map_err(|e| S3Error::Sdk(e.to_string()))?;

        Ok(())
    }
}

/// 拡張子から Content-Type を決める。未知の拡張子は application/octet-stream。
pub fn content_type_for_extension(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_content_type_for_extension_known() {
        assert_eq!(content_type_for_extension("images/foo.png"), "image/png");
        assert_eq!(content_type_for_extension("foo.jpg"), "image/jpeg");
        assert_eq!(content_type_for_extension("foo.jpeg"), "image/jpeg");
        assert_eq!(content_type_for_extension("foo.webp"), "image/webp");
        assert_eq!(content_type_for_extension("foo.gif"), "image/gif");
        assert_eq!(content_type_for_extension("foo.svg"), "image/svg+xml");
    }

    #[test]
    fn test_content_type_for_extension_case_insensitive() {
        assert_eq!(content_type_for_extension("foo.PNG"), "image/png");
        assert_eq!(content_type_for_extension("foo.JPG"), "image/jpeg");
    }

    #[test]
    fn test_content_type_for_extension_unknown_falls_back() {
        assert_eq!(
            content_type_for_extension("foo.bin"),
            "application/octet-stream"
        );
        assert_eq!(
            content_type_for_extension("no_extension"),
            "application/octet-stream"
        );
    }
}
