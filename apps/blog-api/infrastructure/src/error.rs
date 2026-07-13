use thiserror::Error;

#[derive(Error, Debug)]
pub enum GitHubError {
    #[error("HTTP request failed: {0}")]
    Http(#[from] reqwest::Error),

    #[error("JWT generation failed: {0}")]
    Jwt(#[from] jsonwebtoken::errors::Error),

    #[error("GitHub API error: {status} - {message}")]
    Api { status: u16, message: String },

    #[error("Base64 decode error: {0}")]
    Base64Decode(#[from] base64::DecodeError),

    #[error("UTF-8 decode error: {0}")]
    Utf8Decode(#[from] std::string::FromUtf8Error),
}

#[derive(Error, Debug)]
pub enum SsmError {
    #[error("Parameter not found: {0}")]
    ParameterNotFound(String),

    #[error("AWS SDK error: {0}")]
    Sdk(String),
}

#[derive(Error, Debug)]
pub enum CloudinaryError {
    #[error("Invalid configuration: {0}")]
    InvalidConfig(String),
}

#[derive(Error, Debug)]
pub enum LambdaInvokeError {
    #[error("Lambda invoke failed: {0}")]
    Sdk(String),
}

#[derive(Error, Debug)]
pub enum WebhookError {
    #[error("Missing X-Hub-Signature-256 header")]
    MissingSignature,

    #[error("Invalid signature format")]
    InvalidSignatureFormat,

    #[error("Signature verification failed")]
    SignatureVerificationFailed,
}
