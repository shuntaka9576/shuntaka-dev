use axum::{Json, body::Bytes, extract::State, http::HeaderMap};
use futures::future::join_all;
use infrastructure::github::{GitHubAppClient, GitHubAppClientImpl, PushEvent};
use infrastructure::webhook::verify_signature;
use kernel::model::article::Slug;
use kernel::model::frontmatter::ArticleFrontmatter;
use kernel::repository::articles::UpsertArticleInput;
use markdown::convert_markdown_to_html;
use registry::AppRegistry;
use serde::{Deserialize, Serialize};
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

#[utoipa::path(
    post,
    path = "/webhooks/github",
    responses(
        (status = 200, description = "Webhook processed successfully", body = WebhookResponse),
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

    if event_type != "push" {
        return Ok(Json(WebhookResponse {
            status: "skipped".to_string(),
            message: Some(format!("Not a push event: {event_type}")),
            processed: None,
            succeeded: None,
            failed: None,
        }));
    }

    // Parse as PushEvent
    let push_event: PushEvent = serde_json::from_value(parsed_body)
        .map_err(|e| AppError::bad_request_with("Invalid payload", e))?;

    info!(
        "Processing push event: ref={}, repo={}",
        push_event.git_ref, push_event.repository.full_name
    );

    // Check branch
    let branch_name = match extract_branch_name(&push_event.git_ref) {
        Some(name) => name,
        None => {
            warn!("Invalid git ref: {}", push_event.git_ref);
            return Ok(Json(WebhookResponse {
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
        return Ok(Json(WebhookResponse {
            status: "skipped".to_string(),
            message: Some(format!("Not a target branch: {branch_name}")),
            processed: None,
            succeeded: None,
            failed: None,
        }));
    }

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

    for fetch_result in fetch_results {
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
                let input = UpsertArticleInput {
                    user_id: user_id.clone(),
                    slug: Slug::new(slug.clone()),
                    title: frontmatter.title,
                    content,
                    content_html,
                    description: frontmatter.description,
                    thumbnail: frontmatter.thumbnail,
                    article_type: frontmatter.article_type,
                    should_publish: frontmatter.publish,
                    tags: frontmatter.tags,
                };

                // Upsert article
                match registry.articles_repository().upsert_article(input).await {
                    Ok(result) => {
                        info!("Article upserted: slug={}, result={:?}", slug, result);
                        succeeded += 1;
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
                    slug: "unknown".to_string(),
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

    Ok(Json(WebhookResponse {
        status: "success".to_string(),
        message: None,
        processed: Some(processed),
        succeeded: Some(succeeded),
        failed: Some(failed),
    }))
}
