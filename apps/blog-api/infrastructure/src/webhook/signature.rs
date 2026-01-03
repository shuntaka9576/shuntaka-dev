use hmac::{Hmac, Mac};
use sha2::Sha256;

use crate::error::WebhookError;

type HmacSha256 = Hmac<Sha256>;

/// Verify GitHub webhook signature (X-Hub-Signature-256)
///
/// # Arguments
/// * `secret` - The webhook secret configured in GitHub
/// * `payload` - The raw request body bytes
/// * `signature_header` - The X-Hub-Signature-256 header value (e.g., "sha256=...")
///
/// # Returns
/// * `Ok(())` if the signature is valid
/// * `Err(WebhookError)` if the signature is invalid or malformed
pub fn verify_signature(
    secret: &str,
    payload: &[u8],
    signature_header: &str,
) -> Result<(), WebhookError> {
    let signature_hex = signature_header
        .strip_prefix("sha256=")
        .ok_or(WebhookError::InvalidSignatureFormat)?;

    let signature_bytes =
        hex::decode(signature_hex).map_err(|_| WebhookError::InvalidSignatureFormat)?;

    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC can take key of any size");
    mac.update(payload);

    mac.verify_slice(&signature_bytes)
        .map_err(|_| WebhookError::SignatureVerificationFailed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_verify_signature_valid() {
        let secret = "test_secret";
        let payload = b"test payload";

        // Calculate expected signature
        let mut mac =
            HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC can take key of any size");
        mac.update(payload);
        let result = mac.finalize();
        let expected_hex = hex::encode(result.into_bytes());
        let signature = format!("sha256={expected_hex}");

        assert!(verify_signature(secret, payload, &signature).is_ok());
    }

    #[test]
    fn test_verify_signature_invalid() {
        let secret = "test_secret";
        let payload = b"test payload";
        let wrong_signature =
            "sha256=0000000000000000000000000000000000000000000000000000000000000000";

        assert!(matches!(
            verify_signature(secret, payload, wrong_signature),
            Err(WebhookError::SignatureVerificationFailed)
        ));
    }

    #[test]
    fn test_verify_signature_missing_prefix() {
        let secret = "test_secret";
        let payload = b"test payload";
        let invalid = "no_prefix";

        assert!(matches!(
            verify_signature(secret, payload, invalid),
            Err(WebhookError::InvalidSignatureFormat)
        ));
    }

    #[test]
    fn test_verify_signature_invalid_hex() {
        let secret = "test_secret";
        let payload = b"test payload";
        let invalid_hex = "sha256=not_valid_hex";

        assert!(matches!(
            verify_signature(secret, payload, invalid_hex),
            Err(WebhookError::InvalidSignatureFormat)
        ));
    }
}
