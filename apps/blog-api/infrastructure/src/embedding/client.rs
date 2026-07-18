use std::time::Duration;

use async_trait::async_trait;
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::EmbeddingError;
use crate::observability::observe_external_request;

const EXPECTED_DIMENSION: usize = 2048;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
/// PLaMo Service の chunking.py で公開されている version と一致させる。
/// tidb-embedder (バッチ backfill) が同じ値で source_hash を作るため、webhook 側で
/// 生成した chunk と後段のバッチが同じ hash になる。
pub const CHUNKING_VERSION: &str = "plamo-markdown-1024-v1";
pub const DEFAULT_MAX_TOKENS: u32 = 1024;
pub const DEFAULT_OVERLAP_TOKENS: u32 = 128;

#[derive(Debug, Clone)]
pub struct DocumentChunk {
    pub index: u32,
    pub heading: Option<String>,
    pub content: String,
    pub embedding_text: String,
    pub token_count: u32,
}

#[async_trait]
pub trait EmbeddingClient: Send + Sync {
    async fn embed_query(&self, text: &str) -> Result<Vec<f32>, EmbeddingError>;
    async fn embed_document(&self, text: &str) -> Result<Vec<f32>, EmbeddingError>;
    async fn chunk_document(
        &self,
        title: &str,
        description: &str,
        content: &str,
        max_tokens: u32,
        overlap_tokens: u32,
    ) -> Result<Vec<DocumentChunk>, EmbeddingError>;
}

pub struct EmbeddingClientImpl {
    http_client: Client,
    embed_endpoint: Url,
    chunks_endpoint: Url,
}

#[derive(Serialize)]
struct EmbedRequest<'a> {
    text: &'a str,
    mode: &'static str,
}

#[derive(Debug, Deserialize)]
struct EmbedResponse {
    vector: Vec<f32>,
    dim: usize,
}

#[derive(Serialize)]
struct ChunksRequest<'a> {
    title: &'a str,
    description: &'a str,
    content: &'a str,
    max_tokens: u32,
    overlap_tokens: u32,
}

#[derive(Debug, Deserialize)]
struct ChunkItemResponse {
    index: u32,
    heading: Option<String>,
    content: String,
    embedding_text: String,
    token_count: u32,
}

#[derive(Debug, Deserialize)]
struct ChunksResponse {
    version: String,
    max_tokens: u32,
    overlap_tokens: u32,
    chunks: Vec<ChunkItemResponse>,
}

impl EmbeddingClientImpl {
    pub fn new(base_url: &str) -> Result<Self, EmbeddingError> {
        let mut base = Url::parse(base_url)
            .map_err(|error| EmbeddingError::InvalidEndpoint(error.to_string()))?;
        if base.scheme() != "http" && base.scheme() != "https" {
            return Err(EmbeddingError::InvalidEndpoint(
                "scheme must be http or https".to_string(),
            ));
        }
        let base_path = base.path().trim_end_matches('/').to_string();
        base.set_query(None);
        base.set_fragment(None);

        let mut embed_endpoint = base.clone();
        embed_endpoint.set_path(&format!("{base_path}/embed"));
        let mut chunks_endpoint = base;
        chunks_endpoint.set_path(&format!("{base_path}/chunks"));

        let http_client = Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(EmbeddingError::HttpClient)?;
        Ok(Self {
            http_client,
            embed_endpoint,
            chunks_endpoint,
        })
    }

    fn validate_response(response: EmbedResponse) -> Result<Vec<f32>, EmbeddingError> {
        if response.dim != response.vector.len() {
            return Err(EmbeddingError::InvalidResponse(format!(
                "dim does not match vector length: dim={}, length={}",
                response.dim,
                response.vector.len()
            )));
        }
        if response.vector.len() != EXPECTED_DIMENSION {
            return Err(EmbeddingError::InvalidResponse(format!(
                "unexpected dimension: expected={EXPECTED_DIMENSION}, actual={}",
                response.vector.len()
            )));
        }
        if response.vector.iter().any(|value| !value.is_finite()) {
            return Err(EmbeddingError::InvalidResponse(
                "vector contains a non-finite value".to_string(),
            ));
        }
        Ok(response.vector)
    }

    async fn embed(&self, text: &str, mode: &'static str) -> Result<Vec<f32>, EmbeddingError> {
        observe_external_request("plamo", mode, "POST", "/embed", async {
            let response = self
                .http_client
                .post(self.embed_endpoint.clone())
                .json(&EmbedRequest { text, mode })
                .send()
                .await?;

            if !response.status().is_success() {
                let status = response.status().as_u16();
                let message: String = response.text().await?.chars().take(500).collect();
                return Err(EmbeddingError::Api { status, message });
            }

            Self::validate_response(response.json::<EmbedResponse>().await?)
        })
        .await
    }
}

#[async_trait]
impl EmbeddingClient for EmbeddingClientImpl {
    async fn embed_query(&self, text: &str) -> Result<Vec<f32>, EmbeddingError> {
        self.embed(text, "query").await
    }

    async fn embed_document(&self, text: &str) -> Result<Vec<f32>, EmbeddingError> {
        self.embed(text, "document").await
    }

    async fn chunk_document(
        &self,
        title: &str,
        description: &str,
        content: &str,
        max_tokens: u32,
        overlap_tokens: u32,
    ) -> Result<Vec<DocumentChunk>, EmbeddingError> {
        observe_external_request("plamo", "chunk", "POST", "/chunks", async {
            let response = self
                .http_client
                .post(self.chunks_endpoint.clone())
                .json(&ChunksRequest {
                    title,
                    description,
                    content,
                    max_tokens,
                    overlap_tokens,
                })
                .send()
                .await?;

            if !response.status().is_success() {
                let status = response.status().as_u16();
                let message: String = response.text().await?.chars().take(500).collect();
                return Err(EmbeddingError::Api { status, message });
            }

            let body = response.json::<ChunksResponse>().await?;
            if body.version != CHUNKING_VERSION {
                return Err(EmbeddingError::InvalidResponse(format!(
                    "unexpected chunking version: expected={CHUNKING_VERSION}, actual={}",
                    body.version
                )));
            }
            if body.max_tokens != max_tokens || body.overlap_tokens != overlap_tokens {
                return Err(EmbeddingError::InvalidResponse(format!(
                    "chunks API returned different token config: max={}, overlap={}",
                    body.max_tokens, body.overlap_tokens
                )));
            }
            if body.chunks.is_empty() {
                return Err(EmbeddingError::InvalidResponse(
                    "chunks API returned no chunks".to_string(),
                ));
            }
            for (index, chunk) in body.chunks.iter().enumerate() {
                if chunk.index as usize != index {
                    return Err(EmbeddingError::InvalidResponse(format!(
                        "chunks API index is not sequential: expected={index}, actual={}",
                        chunk.index
                    )));
                }
                if chunk.token_count == 0 {
                    return Err(EmbeddingError::InvalidResponse(format!(
                        "chunks[{index}] token_count must be positive"
                    )));
                }
                if chunk.token_count > max_tokens {
                    return Err(EmbeddingError::InvalidResponse(format!(
                        "chunks[{index}] token_count={} exceeds max_tokens={}",
                        chunk.token_count, max_tokens
                    )));
                }
            }

            Ok(body
                .chunks
                .into_iter()
                .map(|chunk| DocumentChunk {
                    index: chunk.index,
                    heading: chunk.heading,
                    content: chunk.content,
                    embedding_text: chunk.embedding_text,
                    token_count: chunk.token_count,
                })
                .collect())
        })
        .await
    }
}

/// クエリ embedding キャッシュの既定容量。1 エントリ 2048 次元 f32 = 8KB 程度なので
/// 256 件で約 2MB。Lambda のインスタンスメモリに対して十分小さい
pub const QUERY_EMBEDDING_CACHE_CAPACITY: usize = 256;

/// embed_query の結果をクエリ文字列単位でキャッシュする decorator。
///
/// 検索のページ送りは同一クエリで offset だけ変えて再リクエストされるため、
/// (1) 推論コストの節約と、(2) ページ間で同一のクエリベクトルを使うことによる
/// 順序の決定論性の担保、の両方を目的とする。容量超過時は挿入順（FIFO）で追い出す。
/// Lambda ではインスタンス単位のキャッシュになる点に注意（別インスタンスに
/// 当たった場合は再推論になるが、embedding 推論はほぼ決定的なので実害は境界順位の
/// 揺れ可能性程度に留まる）。
///
/// embed_document / chunk_document は都度内容が異なるためキャッシュしない。
pub struct CachedEmbeddingClient {
    inner: std::sync::Arc<dyn EmbeddingClient>,
    capacity: usize,
    cache: std::sync::Mutex<QueryEmbeddingCache>,
}

#[derive(Default)]
struct QueryEmbeddingCache {
    map: std::collections::HashMap<String, Vec<f32>>,
    order: std::collections::VecDeque<String>,
}

impl CachedEmbeddingClient {
    pub fn new(inner: std::sync::Arc<dyn EmbeddingClient>, capacity: usize) -> Self {
        Self {
            inner,
            capacity: capacity.max(1),
            cache: std::sync::Mutex::new(QueryEmbeddingCache::default()),
        }
    }
}

#[async_trait]
impl EmbeddingClient for CachedEmbeddingClient {
    async fn embed_query(&self, text: &str) -> Result<Vec<f32>, EmbeddingError> {
        if let Some(hit) = self
            .cache
            .lock()
            .expect("embedding cache lock poisoned")
            .map
            .get(text)
            .cloned()
        {
            return Ok(hit);
        }

        // lock は await をまたいで保持しない（同一クエリの同時 miss は二重推論を許容）
        let vector = self.inner.embed_query(text).await?;

        let mut cache = self.cache.lock().expect("embedding cache lock poisoned");
        if !cache.map.contains_key(text) {
            if cache.map.len() >= self.capacity
                && let Some(oldest) = cache.order.pop_front()
            {
                cache.map.remove(&oldest);
            }
            cache.order.push_back(text.to_string());
            cache.map.insert(text.to_string(), vector.clone());
        }
        Ok(vector)
    }

    async fn embed_document(&self, text: &str) -> Result<Vec<f32>, EmbeddingError> {
        self.inner.embed_document(text).await
    }

    async fn chunk_document(
        &self,
        title: &str,
        description: &str,
        content: &str,
        max_tokens: u32,
        overlap_tokens: u32,
    ) -> Result<Vec<DocumentChunk>, EmbeddingError> {
        self.inner
            .chunk_document(title, description, content, max_tokens, overlap_tokens)
            .await
    }
}

/// tidb-embedder と同じ JSON レイアウトで SHA-256 を計算する。TS 側は
/// `JSON.stringify({version, maxTokens, overlapTokens, title, description, content})`
/// を hash 元にしているため、Rust 側の struct 順序と rename もこれに揃える。
/// これにより、webhook で書いた chunk を後段の tidb-embedder バッチが同じ hash と
/// 見なしてスキップできる。
pub fn compute_source_hash(
    title: &str,
    description: &str,
    content: &str,
    max_tokens: u32,
    overlap_tokens: u32,
) -> String {
    #[derive(Serialize)]
    struct HashInput<'a> {
        version: &'static str,
        #[serde(rename = "maxTokens")]
        max_tokens: u32,
        #[serde(rename = "overlapTokens")]
        overlap_tokens: u32,
        title: &'a str,
        description: &'a str,
        content: &'a str,
    }

    let payload = serde_json::to_string(&HashInput {
        version: CHUNKING_VERSION,
        max_tokens,
        overlap_tokens,
        title,
        description,
        content,
    })
    .expect("HashInput is always serializable");
    let digest = Sha256::digest(payload.as_bytes());
    hex::encode(digest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoints_append_paths() {
        let client = EmbeddingClientImpl::new("http://localhost:8080/base/").unwrap();
        assert_eq!(
            client.embed_endpoint.as_str(),
            "http://localhost:8080/base/embed"
        );
        assert_eq!(
            client.chunks_endpoint.as_str(),
            "http://localhost:8080/base/chunks"
        );
    }

    #[test]
    fn endpoint_rejects_non_http_scheme() {
        assert!(EmbeddingClientImpl::new("file:///tmp/embed").is_err());
    }

    #[test]
    fn response_rejects_dimension_mismatch() {
        let response = EmbedResponse {
            vector: vec![0.0; EXPECTED_DIMENSION],
            dim: EXPECTED_DIMENSION - 1,
        };
        assert!(EmbeddingClientImpl::validate_response(response).is_err());
    }

    #[test]
    fn response_accepts_expected_dimension() {
        let response = EmbedResponse {
            vector: vec![0.0; EXPECTED_DIMENSION],
            dim: EXPECTED_DIMENSION,
        };
        assert_eq!(
            EmbeddingClientImpl::validate_response(response)
                .unwrap()
                .len(),
            EXPECTED_DIMENSION
        );
    }

    #[test]
    fn source_hash_matches_tidb_embedder_layout() {
        // tidb-embedder が JSON.stringify で出す文字列と同じであること。
        // Node.js の JSON.stringify で下記の値を hash して得られる SHA-256 と一致する。
        let hash = compute_source_hash("title", "desc", "content", 1024, 128);
        let expected_payload = r#"{"version":"plamo-markdown-1024-v1","maxTokens":1024,"overlapTokens":128,"title":"title","description":"desc","content":"content"}"#;
        let expected: String = hex::encode(Sha256::digest(expected_payload.as_bytes()));
        assert_eq!(hash, expected);
    }

    #[derive(Default)]
    struct CountingClient {
        calls: std::sync::atomic::AtomicUsize,
    }

    #[async_trait]
    impl EmbeddingClient for CountingClient {
        async fn embed_query(&self, text: &str) -> Result<Vec<f32>, EmbeddingError> {
            self.calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(vec![text.len() as f32])
        }

        async fn embed_document(&self, _text: &str) -> Result<Vec<f32>, EmbeddingError> {
            unreachable!("not exercised in cache tests")
        }

        async fn chunk_document(
            &self,
            _title: &str,
            _description: &str,
            _content: &str,
            _max_tokens: u32,
            _overlap_tokens: u32,
        ) -> Result<Vec<DocumentChunk>, EmbeddingError> {
            unreachable!("not exercised in cache tests")
        }
    }

    #[tokio::test]
    async fn cached_embed_query_reuses_vector_for_same_query() {
        let inner = std::sync::Arc::new(CountingClient::default());
        let cached = CachedEmbeddingClient::new(inner.clone(), 2);

        let first = cached.embed_query("rust axum").await.unwrap();
        let second = cached.embed_query("rust axum").await.unwrap();

        assert_eq!(first, second);
        assert_eq!(inner.calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn cached_embed_query_evicts_oldest_beyond_capacity() {
        let inner = std::sync::Arc::new(CountingClient::default());
        let cached = CachedEmbeddingClient::new(inner.clone(), 2);

        cached.embed_query("a").await.unwrap();
        cached.embed_query("b").await.unwrap();
        cached.embed_query("c").await.unwrap(); // 容量超過で "a" を追い出す
        cached.embed_query("a").await.unwrap(); // miss になり再推論
        assert_eq!(inner.calls.load(std::sync::atomic::Ordering::SeqCst), 4);

        cached.embed_query("c").await.unwrap(); // "c" はまだキャッシュ内
        assert_eq!(inner.calls.load(std::sync::atomic::Ordering::SeqCst), 4);
    }
}
