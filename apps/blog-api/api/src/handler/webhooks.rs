use axum::{Json, body::Bytes, extract::State, http::HeaderMap};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use futures::future::join_all;
use infrastructure::embedding::client::{
    CHUNKING_VERSION, DEFAULT_MAX_TOKENS, DEFAULT_OVERLAP_TOKENS, DocumentChunk, EmbeddingClient,
    compute_source_hash,
};
use infrastructure::github::{GitHubAppClient, GitHubAppClientImpl, PushEvent};
use infrastructure::webhook::verify_signature;
use kernel::model::article::{ArticleId, Slug};
use kernel::model::frontmatter::ArticleFrontmatter;
use kernel::repository::articles::{ArticleEmbeddingChunk, UpsertArticleInput, UpsertResult};
use markdown::convert_markdown_to_html;
use registry::AppRegistry;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::sync::LazyLock;
use tracing::{error, info, warn};
use utoipa::ToSchema;

use crate::error::AppError;

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct WebhookResponse {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub processed: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub succeeded: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed: Option<usize>,
}

pub const GITHUB_PUSH_ENVELOPE_KIND: &str = "github_push_webhook";

/// 自己 Event invoke で受け渡す封筒。Lambda Web Adapter が非 HTTP イベントを
/// AWS_LWA_PASS_THROUGH_PATH (POST /events) へ転送してくる。
/// /events は API Gateway の {proxy+} 経由でも外部から到達できるため、
/// 受信時と同じバイト列で署名を再検証できるよう body は base64 で保持する。
#[derive(Debug, Serialize, Deserialize)]
pub struct GithubPushEnvelope {
    pub kind: String,
    pub signature: String,
    pub body_b64: String,
}

#[derive(Debug)]
struct ArticleProcessError {
    slug: String,
    error: String,
}

fn extract_branch_name(git_ref: &str) -> Option<String> {
    static BRANCH_NAME_RE: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"^refs/heads/(.+)$").unwrap());
    BRANCH_NAME_RE
        .captures(git_ref)
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str().to_string())
}

/// push イベントを検証し、対象ブランチなら Some(PushEvent) を返す。
/// 対象外 (push 以外・対象外ブランチ等) は Err ではなく Ok(None) 相当の
/// skipped レスポンスを返せるよう、WebhookResponse を返す。
fn screen_push_event(
    event_type: &str,
    parsed_body: serde_json::Value,
) -> Result<Result<PushEvent, WebhookResponse>, AppError> {
    if event_type != "push" {
        return Ok(Err(WebhookResponse {
            status: "skipped".to_string(),
            message: Some(format!("Not a push event: {event_type}")),
            processed: None,
            succeeded: None,
            failed: None,
        }));
    }

    let push_event: PushEvent = serde_json::from_value(parsed_body)
        .map_err(|e| AppError::bad_request_with("Invalid payload", e))?;

    let branch_name = match extract_branch_name(&push_event.git_ref) {
        Some(name) => name,
        None => {
            warn!("Invalid git ref: {}", push_event.git_ref);
            return Ok(Err(WebhookResponse {
                status: "skipped".to_string(),
                message: Some(format!("Invalid git ref: {}", push_event.git_ref)),
                processed: None,
                succeeded: None,
                failed: None,
            }));
        }
    };

    if !["main", "master"].contains(&branch_name.as_str()) {
        info!("Skipping non-target branch: {}", branch_name);
        return Ok(Err(WebhookResponse {
            status: "skipped".to_string(),
            message: Some(format!("Not a target branch: {branch_name}")),
            processed: None,
            succeeded: None,
            failed: None,
        }));
    }

    Ok(Ok(push_event))
}

#[utoipa::path(
    post,
    path = "/webhooks/github",
    responses(
        (status = 200, description = "Webhook accepted or processed", body = WebhookResponse),
        (status = 400, description = "Invalid payload"),
        (status = 401, description = "Unauthorized - Invalid or missing signature"),
        (status = 404, description = "User not found"),
        (status = 500, description = "Internal server error")
    ),
    tag = "webhooks"
)]
pub async fn handle_github_webhook(
    State(registry): State<AppRegistry>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<WebhookResponse>, AppError> {
    // Get config from registry
    let config = registry.webhook_config();

    // Verify X-Hub-Signature-256 signature
    let signature = headers
        .get("X-Hub-Signature-256")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| {
            warn!("Missing X-Hub-Signature-256 header");
            AppError::unauthorized("Missing X-Hub-Signature-256 header")
        })?;

    // Verify signature using webhook secret embedded at deploy time.
    verify_signature(&config.github_webhook_secret, &body, signature).map_err(|e| {
        warn!("Webhook signature verification failed: {}", e);
        AppError::unauthorized("Invalid signature")
    })?;

    // Parse JSON body
    let parsed_body: serde_json::Value =
        serde_json::from_slice(&body).map_err(|e| AppError::bad_request_with("Invalid JSON", e))?;

    // Get X-GitHub-Event header
    let event_type = headers
        .get("X-GitHub-Event")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    info!("Received GitHub webhook: event_type={}", event_type);

    let push_event = match screen_push_event(event_type, parsed_body)? {
        Ok(push_event) => push_event,
        Err(skipped) => return Ok(Json(skipped)),
    };

    info!(
        "Processing push event: ref={}, repo={}",
        push_event.git_ref, push_event.repository.full_name
    );

    // GitHub の webhook 配信タイムアウトは 10 秒固定のため、全記事スキャンを伴う
    // 実処理は自己 Event invoke に逃がして即座に 200 を返す。
    // ローカル開発 (Lambda 外) では invoker が無いので従来どおりインラインで処理する。
    match registry.self_invoker() {
        Some(invoker) => {
            let envelope = GithubPushEnvelope {
                kind: GITHUB_PUSH_ENVELOPE_KIND.to_string(),
                signature: signature.to_string(),
                body_b64: BASE64.encode(&body),
            };
            let payload = serde_json::to_vec(&envelope)
                .map_err(|e| AppError::internal("Failed to serialize envelope", e))?;

            invoker
                .invoke_async(payload)
                .await
                .map_err(|e| AppError::internal("Failed to invoke self for async processing", e))?;

            info!(
                "Queued push event for async processing: ref={}, repo={}",
                push_event.git_ref, push_event.repository.full_name
            );

            Ok(Json(WebhookResponse {
                status: "accepted".to_string(),
                message: Some("Queued for async processing".to_string()),
                processed: None,
                succeeded: None,
                failed: None,
            }))
        }
        None => process_push_event(&registry, push_event).await.map(Json),
    }
}

/// 自己 Event invoke されたイベントの受け口 (Lambda Web Adapter の passthrough)。
/// API Gateway 経由でも外部から到達できるため、封筒内の署名を必ず再検証する。
pub async fn handle_lambda_events(
    State(registry): State<AppRegistry>,
    body: Bytes,
) -> Result<Json<WebhookResponse>, AppError> {
    let envelope: GithubPushEnvelope = serde_json::from_slice(&body)
        .map_err(|e| AppError::bad_request_with("Invalid event payload", e))?;

    if envelope.kind != GITHUB_PUSH_ENVELOPE_KIND {
        return Err(AppError::bad_request(&format!(
            "Unsupported event kind: {}",
            envelope.kind
        )));
    }

    let webhook_body = BASE64
        .decode(&envelope.body_b64)
        .map_err(|e| AppError::bad_request_with("Invalid base64 body", e))?;

    let config = registry.webhook_config();
    verify_signature(
        &config.github_webhook_secret,
        &webhook_body,
        &envelope.signature,
    )
    .map_err(|e| {
        warn!("Event signature verification failed: {}", e);
        AppError::unauthorized("Invalid signature")
    })?;

    let parsed_body: serde_json::Value = serde_json::from_slice(&webhook_body)
        .map_err(|e| AppError::bad_request_with("Invalid JSON", e))?;

    // 封筒 kind が push を意味するので event_type は固定で通す
    let push_event = match screen_push_event("push", parsed_body)? {
        Ok(push_event) => push_event,
        Err(skipped) => return Ok(Json(skipped)),
    };

    info!(
        "Processing async push event: ref={}, repo={}",
        push_event.git_ref, push_event.repository.full_name
    );

    process_push_event(&registry, push_event).await.map(Json)
}

/// push イベントの実処理。articles ディレクトリの全 markdown を取得して upsert する。
/// GitHub の配信タイムアウトを気にしなくてよい経路 (自己 invoke / ローカル) で呼ばれる。
async fn process_push_event(
    registry: &AppRegistry,
    push_event: PushEvent,
) -> Result<WebhookResponse, AppError> {
    let config = registry.webhook_config();

    // Create GitHub client using app PEM embedded at deploy time.
    let github_client = GitHubAppClientImpl::new(
        config.github_app_id.clone(),
        config.github_app_secret_pem.clone(),
    );

    let access_token = github_client
        .get_access_token(push_event.installation.id)
        .await
        .map_err(|e| AppError::internal("Failed to get GitHub access token", e))?;

    // Get owner name
    let owner = push_event
        .repository
        .owner
        .name
        .as_ref()
        .unwrap_or(&push_event.repository.owner.login);

    // List files in articles directory
    let contents = github_client
        .list_contents(
            owner,
            &push_event.repository.name,
            &config.articles_dir,
            &access_token,
        )
        .await
        .map_err(|e| AppError::internal("Failed to list articles directory", e))?;

    // Filter markdown files
    let file_paths: Vec<_> = contents
        .into_iter()
        .filter(|c| c.content_type == "file" && c.name.ends_with(".md"))
        .map(|c| c.path)
        .collect();

    info!("Found {} markdown files", file_paths.len());

    // Fetch all file contents in parallel
    let fetch_futures = file_paths.iter().map(|path| {
        github_client.get_content(owner, &push_event.repository.name, path, &access_token)
    });
    let fetch_results = join_all(fetch_futures).await;

    // Resolve user_id from installation_id
    let user_id = registry
        .users_repository()
        .find_by_installation_id(push_event.installation.id)
        .await
        .map_err(|e| AppError::internal("Failed to find user by installation_id", e))?
        .ok_or_else(|| {
            error!(
                "User not found for installation_id: {}",
                push_event.installation.id
            );
            AppError::not_found("User not found")
        })?;

    // Process each article
    let mut processed = 0;
    let mut succeeded = 0;
    let mut failed = 0;
    let mut errors: Vec<ArticleProcessError> = vec![];
    // PLaMO Service へ到達できる環境でのみ Some。未設定でも記事の upsert 自体は成功させる。
    let embedding_client = registry.embedding_client();

    for (file_path, fetch_result) in file_paths.iter().zip(fetch_results) {
        processed += 1;

        match fetch_result {
            Ok(file_content) => {
                // Decode base64 content
                let markdown = match github_client.decode_content(&file_content) {
                    Ok(content) => content,
                    Err(e) => {
                        failed += 1;
                        errors.push(ArticleProcessError {
                            slug: file_content.name.clone(),
                            error: format!("Failed to decode content: {e}"),
                        });
                        continue;
                    }
                };

                // Parse frontmatter
                let (frontmatter, content) = match ArticleFrontmatter::parse(&markdown) {
                    Ok(result) => result,
                    Err(e) => {
                        failed += 1;
                        errors.push(ArticleProcessError {
                            slug: file_content.name.clone(),
                            error: format!("Failed to parse frontmatter: {e}"),
                        });
                        continue;
                    }
                };

                // Extract slug from filename
                let slug = file_content.name.trim_end_matches(".md").to_string();

                // content が変わった場合と新規作成時のみ HTML を再生成する。
                // それ以外は None を渡して既存の content_html を維持する。
                // 既存レコードの埋め戻しは tools/content-html-backfill で行う
                // （webhook 経由だと UPDATE で updated_at が更新されてしまうため）
                let existing = match registry
                    .articles_repository()
                    .find_by_user_id_and_slug(&user_id, &slug)
                    .await
                {
                    Ok(existing) => existing,
                    Err(e) => {
                        failed += 1;
                        errors.push(ArticleProcessError {
                            slug,
                            error: format!("Database error: {e}"),
                        });
                        continue;
                    }
                };

                let needs_html = match &existing {
                    Some(article) => article.content.as_str() != content,
                    None => true,
                };

                // ArticlesRepository の upsert が保存する description。frontmatter が
                // None のときは既存値を維持、なければ title をデフォルトにする挙動と一致させる。
                let effective_description = frontmatter
                    .description
                    .clone()
                    .or_else(|| existing.as_ref().map(|a| a.description.as_str().to_string()))
                    .unwrap_or_else(|| frontmatter.title.clone());

                // title / description / content のいずれかが変わったら chunk を再生成する。
                // upsert 内の判定と揃えるため、description は effective 値で比較する。
                let needs_chunks = match &existing {
                    Some(article) => {
                        article.content.as_str() != content
                            || article.title.as_str() != frontmatter.title
                            || article.description.as_str() != effective_description
                    }
                    None => true,
                };

                let content_html = if needs_html {
                    // OGP リンクカードや GitHub 埋め込みで同期 HTTP フェッチが走るため
                    // blocking スレッドで実行して tokio ワーカーを塞がない
                    let markdown_content = content.clone();
                    match tokio::task::spawn_blocking(move || {
                        convert_markdown_to_html(&markdown_content)
                    })
                    .await
                    {
                        Ok(html) => Some(html),
                        Err(e) => {
                            failed += 1;
                            errors.push(ArticleProcessError {
                                slug,
                                error: format!("Failed to convert markdown: {e}"),
                            });
                            continue;
                        }
                    }
                } else {
                    None
                };

                // Build upsert input
                let title = frontmatter.title.clone();
                let content_for_chunks = content.clone();
                let input = UpsertArticleInput {
                    user_id: user_id.clone(),
                    slug: Slug::new(slug.clone()),
                    title: frontmatter.title,
                    content,
                    content_html,
                    description: frontmatter.description,
                    thumbnail: frontmatter.thumbnail,
                    should_publish: frontmatter.publish,
                    tags: frontmatter.tags,
                };

                // Upsert article
                match registry.articles_repository().upsert_article(input).await {
                    Ok(result) => {
                        info!("Article upserted: slug={}, result={:?}", slug, result);
                        succeeded += 1;

                        if needs_chunks {
                            let article_id = upsert_result_article_id(&result);
                            regenerate_chunks(
                                registry,
                                embedding_client.as_ref(),
                                &article_id,
                                &slug,
                                &title,
                                &effective_description,
                                &content_for_chunks,
                            )
                            .await;
                        }
                    }
                    Err(e) => {
                        error!("Failed to upsert article: slug={}, error={}", slug, e);
                        failed += 1;
                        errors.push(ArticleProcessError {
                            slug,
                            error: format!("Database error: {e}"),
                        });
                    }
                }
            }
            Err(e) => {
                failed += 1;
                errors.push(ArticleProcessError {
                    slug: file_path.clone(),
                    error: format!("Failed to fetch content: {e}"),
                });
            }
        }
    }

    // Log errors if any
    for err in &errors {
        warn!(
            "Article processing error: slug={}, error={}",
            err.slug, err.error
        );
    }

    info!(
        "Webhook processing complete: processed={}, succeeded={}, failed={}",
        processed, succeeded, failed
    );

    Ok(WebhookResponse {
        status: "success".to_string(),
        message: None,
        processed: Some(processed),
        succeeded: Some(succeeded),
        failed: Some(failed),
    })
}

fn upsert_result_article_id(result: &UpsertResult) -> ArticleId {
    match result {
        UpsertResult::Created(id)
        | UpsertResult::Updated(id)
        | UpsertResult::TagsUpdated(id)
        | UpsertResult::NoChange(id) => id.clone(),
    }
}

/// 記事 upsert 直後に呼ぶ chunk 再生成。PLaMO 呼び出しや DB 書き込みの失敗は
/// warn ログを残して呑み込み、既存 chunk を保持する。上位ループは記事 upsert 自体を
/// 成功として扱う。
async fn regenerate_chunks(
    registry: &AppRegistry,
    embedding_client: Option<&Arc<dyn EmbeddingClient>>,
    article_id: &ArticleId,
    slug: &str,
    title: &str,
    description: &str,
    content: &str,
) {
    let Some(client) = embedding_client else {
        info!(
            "Skipping chunk regeneration (PLAMO_EMBED_ENDPOINT not configured): slug={}",
            slug
        );
        return;
    };

    let chunks = match client
        .chunk_document(
            title,
            description,
            content,
            DEFAULT_MAX_TOKENS,
            DEFAULT_OVERLAP_TOKENS,
        )
        .await
    {
        Ok(chunks) => chunks,
        Err(e) => {
            warn!(
                "Failed to chunk article, keeping existing chunks: slug={}, error={}",
                slug, e
            );
            return;
        }
    };

    let mut embedded: Vec<ArticleEmbeddingChunk> = Vec::with_capacity(chunks.len());
    for chunk in chunks {
        let DocumentChunk {
            index,
            heading,
            content: chunk_content,
            embedding_text,
            token_count,
        } = chunk;
        match client.embed_document(&embedding_text).await {
            Ok(vector) => {
                embedded.push(ArticleEmbeddingChunk {
                    chunk_index: index,
                    heading,
                    content: chunk_content,
                    token_count,
                    embedding: vector,
                });
            }
            Err(e) => {
                warn!(
                    "Failed to embed chunk, keeping existing chunks: slug={}, chunk_index={}, error={}",
                    slug, index, e
                );
                return;
            }
        }
    }

    let source_hash = compute_source_hash(
        title,
        description,
        content,
        DEFAULT_MAX_TOKENS,
        DEFAULT_OVERLAP_TOKENS,
    );

    if let Err(e) = registry
        .articles_repository()
        .replace_article_chunks(article_id, &embedded, CHUNKING_VERSION, &source_hash)
        .await
    {
        warn!(
            "Failed to persist article chunks, keeping existing chunks: slug={}, error={}",
            slug, e
        );
        return;
    }

    info!(
        "Article chunks replaced: slug={}, chunks={}",
        slug,
        embedded.len()
    );
}
