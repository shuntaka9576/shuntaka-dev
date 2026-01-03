use base64::Engine;
use sha1::{Digest, Sha1};

pub trait CloudinaryClient: Send + Sync {
    fn create_signed_ogp_url(&self, public_id: &str, title: &str, ext: &str) -> String;
}

pub struct CloudinaryClientImpl {
    cloud_name: String,
    api_secret: String,
}

impl CloudinaryClientImpl {
    pub fn new(cloud_name: String, api_secret: String) -> Self {
        Self {
            cloud_name,
            api_secret,
        }
    }
}

impl CloudinaryClient for CloudinaryClientImpl {
    fn create_signed_ogp_url(&self, public_id: &str, title: &str, ext: &str) -> String {
        // URL encode the title for use in transformation
        let encoded_title = urlencoding::encode(title);

        // Build transformation string matching legacy:
        // font_family: notesansjpmid.otf, font_size: 48, font_weight: bold
        // color: #525457, width: 600, crop: fit
        let transformation =
            format!("c_fit,co_rgb:525457,l_text:notesansjpmid.otf_48_bold:{encoded_title},w_600");

        // Build the path to sign: transformation/v1/public_id.ext + api_secret
        // Cloudinary uses SHA1 (not HMAC) for signature
        let to_sign = format!(
            "{}/v1/{}.{}{}",
            transformation, public_id, ext, self.api_secret
        );

        // Generate SHA1 hash and encode as base64
        let mut hasher = Sha1::new();
        hasher.update(to_sign.as_bytes());
        let result = hasher.finalize();
        let signature = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(result);

        // Take first 8 characters of signature
        let short_sig = &signature[..8.min(signature.len())];

        format!(
            "https://res.cloudinary.com/{}/image/upload/s--{}--/{}/v1/{}.{}",
            self.cloud_name, short_sig, transformation, public_id, ext
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_signed_ogp_url() {
        let client =
            CloudinaryClientImpl::new("test_cloud".to_string(), "test_secret".to_string());

        let url = client.create_signed_ogp_url("blog/og/ogp", "Hello World", "webp");

        assert!(url.starts_with("https://res.cloudinary.com/test_cloud/image/upload/s--"));
        assert!(url.contains("Hello%20World"));
        assert!(url.contains("/v1/blog/og/ogp.webp"));
    }
}
