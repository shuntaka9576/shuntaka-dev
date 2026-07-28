use axum::{Json, body::Bytes, extract::State, http::HeaderMap};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use futures::future::join_all;
use infrastructure::embedding::client::{
    CHUNKING_VERSION, DEFAULT_MAX_TOKENS, DEFAULT_OVERLAP_TOKENS, DocumentChunk, EmbeddingClient,
    compute_source_hash,
};
use infrastructure::github::{GitHubAppClient, GitHubAppClientImpl, GitTreeItem, PushEvent};
use infrastructure::s3::content_type_for_extension;
use infrastructure::webhook::verify_signature;
use kernel::model::article::{ArticleId, Slug, UserId};
use kernel::model::frontmatter::ArticleFrontmatter;
use kernel::model::lab::{ChapterFrontmatter, LabConfig, LabId};
use kernel::repository::articles::{ArticleEmbeddingChunk, UpsertArticleInput, UpsertResult};
use kernel::repository::labs::UpsertChapterInput;
use kernel::repository::labs::UpsertLabInput;
use markdown::convert_markdown_to_html;
use registry::{AppRegistry, WebhookConfig};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};
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

/// push 対象リポジトリの種別。lab-contents リポジトリ (LAB_REPO_FULL_NAME) からの
/// push は "labs"、それ以外は従来どおり "articles" として処理する。
pub const ARTICLES_PUSH_KIND: &str = "articles";
pub const LABS_PUSH_KIND: &str = "labs";

/// 自己 Event invoke で受け渡す封筒。Lambda Web Adapter が非 HTTP イベントを
/// AWS_LWA_PASS_THROUGH_PATH (POST /events) へ転送してくる。
/// /events は API Gateway の {proxy+} 経由でも外部から到達できるため、
/// 受信時と同じバイト列で署名を再検証できるよう body は base64 で保持する。
///
/// kind は ARTICLES_PUSH_KIND / LABS_PUSH_KIND のいずれか。デプロイ中の
/// in-flight envelope (旧デプロイが enqueue し新デプロイが処理する場合) を含め、
/// LABS_PUSH_KIND 以外の値は articles として扱うため後方互換になる。
#[derive(Debug, Serialize, Deserialize)]
pub struct GithubPushEnvelope {
    pub kind: String,
    pub signature: String,
    pub body_b64: String,
}

/// push イベントの repository.full_name から処理対象の kind を判定する。
/// LAB_REPO_FULL_NAME が空、または一致しない場合は articles として扱う。
fn resolve_push_kind(config: &WebhookConfig, push_event: &PushEvent) -> &'static str {
    if !config.lab_repo_full_name.is_empty()
        && push_event.repository.full_name == config.lab_repo_full_name
    {
        LABS_PUSH_KIND
    } else {
        ARTICLES_PUSH_KIND
    }
}

#[derive(Debug)]
struct ArticleProcessError {
    slug: String,
    error: String,
}

#[derive(Debug)]
struct LabProcessError {
    lab_slug: String,
    chapter_slug: Option<String>,
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

    let kind = resolve_push_kind(config, &push_event);

    // GitHub の webhook 配信タイムアウトは 10 秒固定のため、全記事スキャンを伴う
    // 実処理は自己 Event invoke に逃がして即座に 200 を返す。
    // ローカル開発 (Lambda 外) では invoker が無いので従来どおりインラインで処理する。
    match registry.self_invoker() {
        Some(invoker) => {
            let envelope = GithubPushEnvelope {
                kind: kind.to_string(),
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
                "Queued push event for async processing: ref={}, repo={}, kind={}",
                push_event.git_ref, push_event.repository.full_name, kind
            );

            Ok(Json(WebhookResponse {
                status: "accepted".to_string(),
                message: Some("Queued for async processing".to_string()),
                processed: None,
                succeeded: None,
                failed: None,
            }))
        }
        None if kind == LABS_PUSH_KIND => process_lab_push_event(&registry, push_event)
            .await
            .map(Json),
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

    // LABS_PUSH_KIND 以外 (旧デプロイが enqueue した envelope を含む) は articles として扱う。
    let is_labs = envelope.kind == LABS_PUSH_KIND;

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
        "Processing async push event: ref={}, repo={}, kind={}",
        push_event.git_ref,
        push_event.repository.full_name,
        if is_labs {
            LABS_PUSH_KIND
        } else {
            ARTICLES_PUSH_KIND
        }
    );

    if is_labs {
        process_lab_push_event(&registry, push_event)
            .await
            .map(Json)
    } else {
        process_push_event(&registry, push_event).await.map(Json)
    }
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

// ─────────────────────────────────────────
// labs 同期
// ─────────────────────────────────────────

/// Git Trees API (recursive) の結果を labs/ 配下の構造に沿ってグルーピングしたもの。
#[derive(Debug, Default)]
struct LabTreeIndex {
    /// labs/ 直下に存在する lab slug 一覧 (config.yaml の有無やパース可否を問わない)。
    /// リポジトリから lab ディレクトリ自体が消えたかどうかの削除判定に使う。
    discovered_labs: BTreeSet<String>,
    /// lab_slug -> (画像の相対パス (images/ 以降) -> blob sha)
    images: HashMap<String, HashMap<String, String>>,
    /// lab_slug -> (章 slug -> フルパス)。同名の .mdx / .md があれば .mdx を優先する
    chapter_paths: HashMap<String, HashMap<String, String>>,
}

/// Git Trees API の結果から labs/ 配下だけを取り出してグルーピングする純関数。
fn index_lab_tree(items: &[GitTreeItem]) -> LabTreeIndex {
    let mut index = LabTreeIndex::default();

    for item in items {
        let Some(rest) = item.path.strip_prefix("labs/") else {
            continue;
        };
        let mut parts = rest.splitn(2, '/');
        let lab_slug = match parts.next() {
            Some(s) if !s.is_empty() => s.to_string(),
            _ => continue,
        };
        index.discovered_labs.insert(lab_slug.clone());

        let Some(remainder) = parts.next() else {
            continue;
        };
        if item.item_type != "blob" {
            continue;
        }

        if let Some(image_rel) = remainder.strip_prefix("images/") {
            index
                .images
                .entry(lab_slug)
                .or_default()
                .insert(image_rel.to_string(), item.sha.clone());
        } else if !remainder.contains('/') {
            // 章ファイルは labs/<slug>/ 直下のみ対象 (images/ 以外のネストは想定しない)
            if let Some(slug) = remainder.strip_suffix(".mdx") {
                index
                    .chapter_paths
                    .entry(lab_slug)
                    .or_default()
                    .insert(slug.to_string(), item.path.clone());
            } else if let Some(slug) = remainder.strip_suffix(".md") {
                // .mdx が既にあれば優先して残す (処理順に依存しない)
                index
                    .chapter_paths
                    .entry(lab_slug)
                    .or_default()
                    .entry(slug.to_string())
                    .or_insert_with(|| item.path.clone());
            }
        }
    }

    index
}

/// リポジトリ上の画像パス (labs/<lab-slug>/images/ 以降の相対パス) から S3 キーを組み立てる。
fn lab_image_s3_key(lab_slug: &str, relative_path: &str) -> String {
    format!("lab-assets/{lab_slug}/images/{relative_path}")
}

/// 章本文中の画像相対参照 (`](images/...)` / `](./images/...)`) を配信 URL に書き換える。
/// image_shas は images/ 以降の相対パスから blob sha を引くマップ。
/// tree に存在しない画像参照 (削除済み・パスミスなど) はそのまま残す。
/// http(s):// などの絶対 URL やアンカーはそもそもこのパターンにマッチしないため対象外。
fn rewrite_lab_image_urls(
    content: &str,
    images_base_url: &str,
    lab_slug: &str,
    image_shas: &HashMap<String, String>,
) -> String {
    static IMAGE_REF_RE: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"\]\((?:\./)?images/([^)\s]+)\)").unwrap());

    IMAGE_REF_RE
        .replace_all(content, |caps: &regex::Captures| {
            let relative_path = &caps[1];
            match image_shas.get(relative_path) {
                Some(sha) => {
                    let short_sha = &sha[..sha.len().min(8)];
                    format!(
                        "]({images_base_url}/{}?v={short_sha})",
                        lab_image_s3_key(lab_slug, relative_path)
                    )
                }
                None => caps[0].to_string(),
            }
        })
        .to_string()
}

/// lab の画像を S3 に同期する。github-sha メタデータで差分判定し、変更分のみ
/// GitHub から取得して PutObject する。S3 クライアントが無い環境 (ローカル開発) や
/// バケット未設定の環境では同期をスキップする。
async fn sync_lab_images(
    registry: &AppRegistry,
    owner: &str,
    repo: &str,
    token: &str,
    github_client: &GitHubAppClientImpl,
    lab_slug: &str,
    images: &HashMap<String, String>,
) {
    let Some(store) = registry.lab_image_store() else {
        info!(
            "Skipping lab image sync (no S3 client in this environment): lab={}",
            lab_slug
        );
        return;
    };

    let bucket = registry.webhook_config().lab_images_bucket.clone();
    if bucket.is_empty() {
        info!(
            "Skipping lab image sync (LAB_IMAGES_BUCKET_NAME not configured): lab={}",
            lab_slug
        );
        return;
    }

    for (relative_path, blob_sha) in images {
        let key = lab_image_s3_key(lab_slug, relative_path);

        let current_sha = match store.head_github_sha(&bucket, &key).await {
            Ok(sha) => sha,
            Err(e) => {
                warn!(
                    "Failed to head lab image, skipping: key={}, error={}",
                    key, e
                );
                continue;
            }
        };

        if current_sha.as_deref() == Some(blob_sha.as_str()) {
            continue;
        }

        let bytes = match github_client
            .get_blob_raw(owner, repo, blob_sha, token)
            .await
        {
            Ok(b) => b,
            Err(e) => {
                warn!(
                    "Failed to fetch image blob, skipping: key={}, error={}",
                    key, e
                );
                continue;
            }
        };

        let content_type = content_type_for_extension(relative_path);

        if let Err(e) = store
            .put_image(&bucket, &key, bytes, content_type, blob_sha)
            .await
        {
            warn!("Failed to put lab image: key={}, error={}", key, e);
        }
    }
}

/// lab push イベントの実処理。Git Trees API で labs/ 配下を一括取得し、
/// lab ごとに config.yaml → 画像 → 章の順に同期する。
/// articles と異なり、リポジトリから消えた lab / 章は DB からハード削除する
/// (admin 専用の閲覧機能で影響範囲が閉じているため)。embedding chunk は生成しない。
async fn process_lab_push_event(
    registry: &AppRegistry,
    push_event: PushEvent,
) -> Result<WebhookResponse, AppError> {
    let config = registry.webhook_config();

    let github_client = GitHubAppClientImpl::new(
        config.github_app_id.clone(),
        config.github_app_secret_pem.clone(),
    );

    let access_token = github_client
        .get_access_token(push_event.installation.id)
        .await
        .map_err(|e| AppError::internal("Failed to get GitHub access token", e))?;

    let owner = push_event
        .repository
        .owner
        .name
        .as_ref()
        .unwrap_or(&push_event.repository.owner.login);

    let user_id: UserId = registry
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

    // git_ref (ブランチ名) ではなく after (push 後の HEAD コミット SHA) を使う。
    // ブランチ名で毎回引くと後続の push と競合しうるため、この時点のコミットを固定で参照する。
    let tree = github_client
        .get_tree_recursive(
            owner,
            &push_event.repository.name,
            &push_event.after,
            &access_token,
        )
        .await
        .map_err(|e| AppError::internal("Failed to fetch labs tree", e))?;

    if tree.truncated {
        warn!("GitHub tree response was truncated; some labs entries may be missing");
    }

    let tree_index = index_lab_tree(&tree.tree);

    let mut processed = 0;
    let mut succeeded = 0;
    let mut failed = 0;
    let mut errors: Vec<LabProcessError> = vec![];

    for lab_slug in &tree_index.discovered_labs {
        let config_path = format!("labs/{lab_slug}/config.yaml");
        let config_file = match github_client
            .get_content(
                owner,
                &push_event.repository.name,
                &config_path,
                &access_token,
            )
            .await
        {
            Ok(file) => file,
            Err(e) => {
                warn!(
                    "Failed to fetch lab config, skipping lab: lab={}, error={}",
                    lab_slug, e
                );
                continue;
            }
        };

        let config_yaml = match github_client.decode_content(&config_file) {
            Ok(yaml) => yaml,
            Err(e) => {
                warn!(
                    "Failed to decode lab config, skipping lab: lab={}, error={}",
                    lab_slug, e
                );
                continue;
            }
        };

        let lab_config = match LabConfig::parse(&config_yaml) {
            Ok(cfg) => cfg,
            Err(e) => {
                warn!(
                    "Failed to parse lab config, skipping lab: lab={}, error={}",
                    lab_slug, e
                );
                continue;
            }
        };

        let empty_images: HashMap<String, String> = HashMap::new();
        let image_shas = tree_index.images.get(lab_slug).unwrap_or(&empty_images);

        if let Some(images) = tree_index.images.get(lab_slug) {
            sync_lab_images(
                registry,
                owner,
                &push_event.repository.name,
                &access_token,
                &github_client,
                lab_slug,
                images,
            )
            .await;
        }

        let lab_id: LabId = match registry
            .labs_repository()
            .upsert_lab(UpsertLabInput {
                user_id: user_id.clone(),
                slug: lab_slug.clone(),
                title: lab_config.title,
                summary: lab_config.summary,
                published: lab_config.published,
            })
            .await
        {
            Ok(id) => id,
            Err(e) => {
                error!("Failed to upsert lab: lab={}, error={}", lab_slug, e);
                errors.push(LabProcessError {
                    lab_slug: lab_slug.clone(),
                    chapter_slug: None,
                    error: format!("Database error: {e}"),
                });
                continue;
            }
        };

        let existing_states = match registry
            .labs_repository()
            .list_chapter_states(&lab_id)
            .await
        {
            Ok(states) => states,
            Err(e) => {
                error!(
                    "Failed to list chapter states, skipping lab: lab={}, error={}",
                    lab_slug, e
                );
                continue;
            }
        };
        let existing_by_slug: HashMap<String, String> = existing_states
            .into_iter()
            .map(|state| (state.slug, state.content))
            .collect();

        let mut keep_chapter_slugs: Vec<String> = vec![];

        for (position, chapter_slug) in lab_config.chapters.iter().enumerate() {
            processed += 1;

            let chapter_path = match tree_index
                .chapter_paths
                .get(lab_slug)
                .and_then(|paths| paths.get(chapter_slug))
            {
                Some(path) => path.clone(),
                None => {
                    // config.yaml が参照する章ファイルがリポジトリから消えているケース。
                    // keep_chapter_slugs に含めないため、既存の章があれば削除される。
                    failed += 1;
                    errors.push(LabProcessError {
                        lab_slug: lab_slug.clone(),
                        chapter_slug: Some(chapter_slug.clone()),
                        error: "Chapter file not found (expected .mdx or .md)".to_string(),
                    });
                    continue;
                }
            };

            // ファイル自体はリポジトリに存在するため、以降で一時的なフェッチ/パース/DB
            // エラーが起きても削除対象にはしない (articles と同じ「エラー時は既存値を
            // 維持する」フェイルセーフ。articles は upsert-only だが labs は
            // delete_chapters_not_in があるため、ここで明示的に keep する必要がある)。
            keep_chapter_slugs.push(chapter_slug.clone());

            let file_content = match github_client
                .get_content(
                    owner,
                    &push_event.repository.name,
                    &chapter_path,
                    &access_token,
                )
                .await
            {
                Ok(fc) => fc,
                Err(e) => {
                    failed += 1;
                    errors.push(LabProcessError {
                        lab_slug: lab_slug.clone(),
                        chapter_slug: Some(chapter_slug.clone()),
                        error: format!("Failed to fetch content: {e}"),
                    });
                    continue;
                }
            };

            let markdown = match github_client.decode_content(&file_content) {
                Ok(content) => content,
                Err(e) => {
                    failed += 1;
                    errors.push(LabProcessError {
                        lab_slug: lab_slug.clone(),
                        chapter_slug: Some(chapter_slug.clone()),
                        error: format!("Failed to decode content: {e}"),
                    });
                    continue;
                }
            };

            let (frontmatter, content) = match ChapterFrontmatter::parse(&markdown) {
                Ok(result) => result,
                Err(e) => {
                    failed += 1;
                    errors.push(LabProcessError {
                        lab_slug: lab_slug.clone(),
                        chapter_slug: Some(chapter_slug.clone()),
                        error: format!("Failed to parse frontmatter: {e}"),
                    });
                    continue;
                }
            };

            let rewritten_content =
                rewrite_lab_image_urls(&content, &config.images_base_url, lab_slug, image_shas);

            // content が変わった場合と新規作成時のみ HTML を再生成する (articles と同じ契約)
            let needs_html = existing_by_slug
                .get(chapter_slug)
                .map(|existing| existing.as_str() != rewritten_content.as_str())
                .unwrap_or(true);

            let content_html = if needs_html {
                let markdown_content = rewritten_content.clone();
                match tokio::task::spawn_blocking(move || {
                    convert_markdown_to_html(&markdown_content)
                })
                .await
                {
                    Ok(html) => Some(html),
                    Err(e) => {
                        failed += 1;
                        errors.push(LabProcessError {
                            lab_slug: lab_slug.clone(),
                            chapter_slug: Some(chapter_slug.clone()),
                            error: format!("Failed to convert markdown: {e}"),
                        });
                        continue;
                    }
                }
            } else {
                None
            };

            let upsert_result = registry
                .labs_repository()
                .upsert_chapter(UpsertChapterInput {
                    lab_id: lab_id.clone(),
                    slug: chapter_slug.clone(),
                    title: frontmatter.title,
                    position: position as i32,
                    content: rewritten_content,
                    content_html,
                })
                .await;

            match upsert_result {
                Ok(()) => {
                    succeeded += 1;
                }
                Err(e) => {
                    failed += 1;
                    errors.push(LabProcessError {
                        lab_slug: lab_slug.clone(),
                        chapter_slug: Some(chapter_slug.clone()),
                        error: format!("Database error: {e}"),
                    });
                }
            }
        }

        if let Err(e) = registry
            .labs_repository()
            .delete_chapters_not_in(&lab_id, &keep_chapter_slugs)
            .await
        {
            error!(
                "Failed to delete stale chapters: lab={}, error={}",
                lab_slug, e
            );
        }
    }

    let keep_lab_slugs: Vec<String> = tree_index.discovered_labs.iter().cloned().collect();
    if let Err(e) = registry
        .labs_repository()
        .delete_labs_not_in(&user_id, &keep_lab_slugs)
        .await
    {
        error!("Failed to delete stale labs: error={}", e);
    }

    for err in &errors {
        warn!(
            "Lab processing error: lab={}, chapter={:?}, error={}",
            err.lab_slug, err.chapter_slug, err.error
        );
    }

    info!(
        "Lab webhook processing complete: processed={}, succeeded={}, failed={}",
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

#[cfg(test)]
mod tests {
    use super::*;
    use infrastructure::github::{Installation, Owner, Repository};

    fn dummy_webhook_config(lab_repo_full_name: &str) -> WebhookConfig {
        WebhookConfig {
            github_app_id: String::new(),
            github_app_secret_pem: String::new(),
            github_webhook_secret: String::new(),
            articles_dir: "articles".to_string(),
            cloudinary_cloud_name: String::new(),
            cloudinary_api_key: String::new(),
            cloudinary_api_secret: String::new(),
            ogp_public_id: String::new(),
            images_base_url: "https://images.shuntaka.dev".to_string(),
            lab_repo_full_name: lab_repo_full_name.to_string(),
            lab_images_bucket: String::new(),
        }
    }

    fn dummy_push_event(full_name: &str) -> PushEvent {
        PushEvent {
            git_ref: "refs/heads/main".to_string(),
            after: "deadbeef".to_string(),
            repository: Repository {
                name: full_name.rsplit('/').next().unwrap().to_string(),
                full_name: full_name.to_string(),
                owner: Owner {
                    name: None,
                    login: "shuntaka9576".to_string(),
                },
            },
            installation: Installation { id: 1 },
        }
    }

    #[test]
    fn test_resolve_push_kind_matches_lab_repo() {
        let config = dummy_webhook_config("shuntaka9576/lab-contents-dev");
        let push_event = dummy_push_event("shuntaka9576/lab-contents-dev");
        assert_eq!(resolve_push_kind(&config, &push_event), LABS_PUSH_KIND);
    }

    #[test]
    fn test_resolve_push_kind_defaults_to_articles_when_mismatched() {
        let config = dummy_webhook_config("shuntaka9576/lab-contents-dev");
        let push_event = dummy_push_event("shuntaka9576/shuntaka-dev");
        assert_eq!(resolve_push_kind(&config, &push_event), ARTICLES_PUSH_KIND);
    }

    #[test]
    fn test_resolve_push_kind_defaults_to_articles_when_lab_repo_unset() {
        let config = dummy_webhook_config("");
        let push_event = dummy_push_event("shuntaka9576/lab-contents-dev");
        assert_eq!(resolve_push_kind(&config, &push_event), ARTICLES_PUSH_KIND);
    }

    fn tree_item(path: &str, item_type: &str, sha: &str) -> GitTreeItem {
        GitTreeItem {
            path: path.to_string(),
            item_type: item_type.to_string(),
            sha: sha.to_string(),
        }
    }

    #[test]
    fn test_index_lab_tree_groups_by_lab() {
        let items = vec![
            tree_item("labs/db", "tree", "t1"),
            tree_item("labs/db/config.yaml", "blob", "c1"),
            tree_item("labs/db/occ.mdx", "blob", "occ-sha"),
            tree_item("labs/db/images", "tree", "t2"),
            tree_item("labs/db/images/snapshot.png", "blob", "img-sha-1"),
            tree_item("labs/db/images/nested/deep.png", "blob", "img-sha-2"),
            tree_item("labs/raft/config.yaml", "blob", "c2"),
            tree_item("labs/raft/overview.md", "blob", "overview-sha"),
        ];

        let index = index_lab_tree(&items);

        assert_eq!(
            index.discovered_labs,
            BTreeSet::from(["db".to_string(), "raft".to_string()])
        );

        let db_images = index.images.get("db").unwrap();
        assert_eq!(
            db_images.get("snapshot.png"),
            Some(&"img-sha-1".to_string())
        );
        assert_eq!(
            db_images.get("nested/deep.png"),
            Some(&"img-sha-2".to_string())
        );

        let db_chapters = index.chapter_paths.get("db").unwrap();
        assert_eq!(db_chapters.get("occ"), Some(&"labs/db/occ.mdx".to_string()));

        let raft_chapters = index.chapter_paths.get("raft").unwrap();
        assert_eq!(
            raft_chapters.get("overview"),
            Some(&"labs/raft/overview.md".to_string())
        );
        assert!(!index.images.contains_key("raft"));
    }

    #[test]
    fn test_index_lab_tree_prefers_mdx_over_md_regardless_of_order() {
        let mdx_first = vec![
            tree_item("labs/db/occ.mdx", "blob", "mdx-sha"),
            tree_item("labs/db/occ.md", "blob", "md-sha"),
        ];
        let index = index_lab_tree(&mdx_first);
        assert_eq!(
            index.chapter_paths.get("db").unwrap().get("occ"),
            Some(&"labs/db/occ.mdx".to_string())
        );

        let md_first = vec![
            tree_item("labs/db/occ.md", "blob", "md-sha"),
            tree_item("labs/db/occ.mdx", "blob", "mdx-sha"),
        ];
        let index = index_lab_tree(&md_first);
        assert_eq!(
            index.chapter_paths.get("db").unwrap().get("occ"),
            Some(&"labs/db/occ.mdx".to_string())
        );
    }

    #[test]
    fn test_lab_image_s3_key() {
        assert_eq!(
            lab_image_s3_key("db", "occ/snapshot.png"),
            "lab-assets/db/images/occ/snapshot.png"
        );
    }

    #[test]
    fn test_rewrite_lab_image_urls_relative_form() {
        let mut shas = HashMap::new();
        shas.insert("snapshot.png".to_string(), "0123456789abcdef".to_string());

        let content = "![説明](images/snapshot.png)";
        let rewritten = rewrite_lab_image_urls(content, "https://images.shuntaka.dev", "db", &shas);

        assert_eq!(
            rewritten,
            "![説明](https://images.shuntaka.dev/lab-assets/db/images/snapshot.png?v=01234567)"
        );
    }

    #[test]
    fn test_rewrite_lab_image_urls_dot_slash_form() {
        let mut shas = HashMap::new();
        shas.insert("snapshot.png".to_string(), "0123456789abcdef".to_string());

        let content = "![説明](./images/snapshot.png)";
        let rewritten = rewrite_lab_image_urls(content, "https://images.shuntaka.dev", "db", &shas);

        assert_eq!(
            rewritten,
            "![説明](https://images.shuntaka.dev/lab-assets/db/images/snapshot.png?v=01234567)"
        );
    }

    #[test]
    fn test_rewrite_lab_image_urls_unknown_image_left_untouched() {
        let shas = HashMap::new();
        let content = "![説明](images/missing.png)";
        let rewritten = rewrite_lab_image_urls(content, "https://images.shuntaka.dev", "db", &shas);

        assert_eq!(rewritten, content);
    }

    #[test]
    fn test_rewrite_lab_image_urls_external_url_left_untouched() {
        let mut shas = HashMap::new();
        shas.insert("snapshot.png".to_string(), "0123456789abcdef".to_string());

        let content = "![説明](https://example.com/images/snapshot.png)";
        let rewritten = rewrite_lab_image_urls(content, "https://images.shuntaka.dev", "db", &shas);

        assert_eq!(rewritten, content);
    }

    #[test]
    fn test_rewrite_lab_image_urls_short_sha_handles_less_than_8_chars() {
        let mut shas = HashMap::new();
        shas.insert("snapshot.png".to_string(), "abc".to_string());

        let content = "![説明](images/snapshot.png)";
        let rewritten = rewrite_lab_image_urls(content, "https://images.shuntaka.dev", "db", &shas);

        assert_eq!(
            rewritten,
            "![説明](https://images.shuntaka.dev/lab-assets/db/images/snapshot.png?v=abc)"
        );
    }
}
