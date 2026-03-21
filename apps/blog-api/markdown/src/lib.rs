use comrak::Options;
use comrak::plugins::syntect::SyntectAdapter;
use regex::Regex;
use scraper::{Html, Selector};
use std::time::Duration;
use url::Url;

/// GitHub link information extracted from URL
#[derive(Debug, Clone)]
struct GitHubLink {
    owner: String,
    repo: String,
    branch: String,
    path: String,
    start_line: Option<usize>,
    end_line: Option<usize>,
    original_url: String,
}

/// OGP information extracted from a webpage
#[derive(Debug, Clone)]
struct OgpInfo {
    url: String,
    title: String,
    description: Option<String>,
    image: Option<String>,
    favicon: Option<String>,
}

/// Fetch HTML content from URL
fn fetch_ogp_html(url: &str) -> Result<String, String> {
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(5)))
        .build()
        .new_agent();

    let response = agent
        .get(url)
        .header("User-Agent", "Mozilla/5.0 (compatible; LinkCardBot/1.0)")
        .call()
        .map_err(|e| e.to_string())?;

    response.into_body().read_to_string().map_err(|e| e.to_string())
}

/// Parse OGP information from HTML
fn parse_ogp(html_content: &str, original_url: &str) -> OgpInfo {
    let document = Html::parse_document(html_content);

    // OGP meta tag selectors
    let og_title_sel = Selector::parse("meta[property='og:title']").unwrap();
    let og_description_sel = Selector::parse("meta[property='og:description']").unwrap();
    let og_image_sel = Selector::parse("meta[property='og:image']").unwrap();

    // Fallback selectors
    let title_sel = Selector::parse("title").unwrap();
    let meta_description_sel = Selector::parse("meta[name='description']").unwrap();

    // Extract title (OGP first, then <title> tag, then URL)
    let title = document
        .select(&og_title_sel)
        .next()
        .and_then(|e| e.value().attr("content"))
        .map(|s| s.to_string())
        .or_else(|| {
            document
                .select(&title_sel)
                .next()
                .map(|e| e.text().collect::<String>())
        })
        .unwrap_or_else(|| original_url.to_string());

    // Extract description
    let description = document
        .select(&og_description_sel)
        .next()
        .and_then(|e| e.value().attr("content"))
        .map(|s| s.to_string())
        .or_else(|| {
            document
                .select(&meta_description_sel)
                .next()
                .and_then(|e| e.value().attr("content"))
                .map(|s| s.to_string())
        });

    // Extract image
    let image = document
        .select(&og_image_sel)
        .next()
        .and_then(|e| e.value().attr("content"))
        .map(|s| resolve_url(original_url, s));

    // Extract favicon
    let favicon = extract_favicon(&document, original_url);

    OgpInfo {
        url: original_url.to_string(),
        title,
        description,
        image,
        favicon,
    }
}

/// Extract favicon URL from HTML document
fn extract_favicon(document: &Html, base_url: &str) -> Option<String> {
    let icon_sel = Selector::parse("link[rel='icon'], link[rel='shortcut icon']").unwrap();

    if let Some(element) = document.select(&icon_sel).next()
        && let Some(href) = element.value().attr("href")
    {
        return Some(resolve_url(base_url, href));
    }

    // Fallback: /favicon.ico
    if let Ok(url) = Url::parse(base_url)
        && let Some(host) = url.host_str()
    {
        return Some(format!("{}://{}/favicon.ico", url.scheme(), host));
    }

    None
}

/// Resolve relative URL to absolute URL
fn resolve_url(base_url: &str, href: &str) -> String {
    if href.starts_with("http://") || href.starts_with("https://") {
        return href.to_string();
    }

    if let Ok(base) = Url::parse(base_url)
        && let Ok(resolved) = base.join(href)
    {
        return resolved.to_string();
    }

    href.to_string()
}

/// Extract domain from URL
fn extract_domain(url: &str) -> String {
    Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|s| s.to_string()))
        .unwrap_or_else(|| url.to_string())
}

/// Truncate string to a maximum number of characters
fn truncate_text(text: &str, max_chars: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max_chars {
        text.to_string()
    } else {
        let truncated: String = chars[..max_chars].iter().collect();
        format!("{truncated}...")
    }
}

/// Render link card HTML (Zenn-style)
fn render_link_card(ogp: &OgpInfo) -> String {
    let domain = extract_domain(&ogp.url);
    let title = truncate_text(&ogp.title, 70);

    let description_html = ogp
        .description
        .as_ref()
        .map(|d| {
            let truncated = truncate_text(d, 100);
            format!(
                r#"<div class="link-card-description">{}</div>"#,
                html_escape(&truncated)
            )
        })
        .unwrap_or_default();

    let image_html = ogp
        .image
        .as_ref()
        .map(|i| {
            format!(
                r#"<div class="link-card-image"><img src="{}" alt="" loading="lazy" onerror="this.parentElement.style.display='none'"></div>"#,
                html_escape(i)
            )
        })
        .unwrap_or_default();

    let favicon_html = ogp
        .favicon
        .as_ref()
        .map(|f| {
            format!(
                r#"<img class="link-card-favicon" src="{}" alt="" onerror="this.style.display='none'">"#,
                html_escape(f)
            )
        })
        .unwrap_or_default();

    // Wrap in <div> to ensure it's treated as a block-level HTML element by comrak
    format!(
        r#"<div class="link-card-wrapper"><a href="{url}" class="link-card" target="_blank" rel="noopener noreferrer"><div class="link-card-content"><div class="link-card-text"><div class="link-card-title">{title}</div>{description}</div>{image}</div><div class="link-card-footer">{favicon}<span class="link-card-domain">{domain}</span></div></a></div>"#,
        url = html_escape(&ogp.url),
        title = html_escape(&title),
        description = description_html,
        image = image_html,
        favicon = favicon_html,
        domain = html_escape(&domain)
    )
}

/// Check if a line contains only a standalone URL (not inside markdown link syntax)
fn is_standalone_url(line: &str) -> bool {
    let trimmed = line.trim();
    if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        return false;
    }
    // Make sure it's not part of a markdown link
    !line.contains('[') && !line.contains('(')
}

/// Check if URL is a GitHub URL (to be processed by GitHub embed instead)
fn is_github_blob_url(url: &str) -> bool {
    url.starts_with("https://github.com/") && url.contains("/blob/")
}

/// Check if URL is an X (formerly Twitter) status URL
fn is_x_url(url: &str) -> bool {
    url.starts_with("https://x.com/") && url.contains("/status/")
}

/// Extract tweet ID from X URL
fn extract_x_tweet_id(url: &str) -> Option<&str> {
    url.split("/status/")
        .nth(1)?
        .split(&['?', '/', '#'][..])
        .next()
        .filter(|id| !id.is_empty() && id.chars().all(|c| c.is_ascii_digit()))
}

/// Process X embeds in markdown
/// Only processes standalone X URLs at the start of a line
fn process_x_embeds(markdown: &str) -> (String, bool) {
    let mut result = String::new();
    let mut in_code_block = false;
    let mut has_x_embed = false;

    for line in markdown.lines() {
        // Track code block state
        if line.starts_with("```") {
            in_code_block = !in_code_block;
            result.push_str(line);
            result.push('\n');
            continue;
        }

        if in_code_block {
            result.push_str(line);
            result.push('\n');
            continue;
        }

        let trimmed = line.trim();

        // Check if line is a standalone X URL
        if is_x_url(trimmed)
            && !line.contains('[')
            && !line.contains('(')
            && let Some(tweet_id) = extract_x_tweet_id(trimmed)
        {
            has_x_embed = true;
            result.push('\n');
            result.push_str(&format!("<div data-tweet-id=\"{tweet_id}\"></div>"));
            result.push_str("\n\n");
            continue;
        }

        result.push_str(line);
        result.push('\n');
    }

    // Remove trailing newline if original didn't have one
    if !markdown.ends_with('\n') && result.ends_with('\n') {
        result.pop();
    }

    (result, has_x_embed)
}

/// Process link cards in markdown
/// Only processes standalone URLs at the start of a line (excluding GitHub blob URLs)
fn process_link_cards(markdown: &str) -> String {
    let mut result = String::new();
    let mut in_code_block = false;

    for line in markdown.lines() {
        // Track code block state
        if line.starts_with("```") {
            in_code_block = !in_code_block;
            result.push_str(line);
            result.push('\n');
            continue;
        }

        if in_code_block {
            result.push_str(line);
            result.push('\n');
            continue;
        }

        let trimmed = line.trim();

        // Check if line is a standalone URL (not GitHub blob, not X)
        if is_standalone_url(trimmed) && !is_github_blob_url(trimmed) && !is_x_url(trimmed) {
            // Skip localhost and internal network URLs
            if trimmed.contains("localhost") || trimmed.contains("127.0.0.1") {
                result.push_str(line);
                result.push('\n');
                continue;
            }

            // Try to fetch OGP info
            match fetch_ogp_html(trimmed) {
                Ok(html_content) => {
                    let ogp = parse_ogp(&html_content, trimmed);
                    let card_html = render_link_card(&ogp);
                    // Add blank lines before and after to ensure HTML block recognition
                    result.push('\n');
                    result.push_str(&card_html);
                    result.push_str("\n\n");
                    continue;
                }
                Err(_) => {
                    // Fallback: keep original URL
                    result.push_str(line);
                    result.push('\n');
                    continue;
                }
            }
        }

        result.push_str(line);
        result.push('\n');
    }

    // Remove trailing newline if original didn't have one
    if !markdown.ends_with('\n') && result.ends_with('\n') {
        result.pop();
    }

    result
}

/// Parse a GitHub blob URL into its components
fn parse_github_link(url: &str) -> Option<GitHubLink> {
    // Pattern: https://github.com/{owner}/{repo}/blob/{branch}/{path}[?plain=1][#L{start}[-L{end}]]
    let re = Regex::new(
        r"^https://github\.com/([^/]+)/([^/]+)/blob/([^/?#]+)/([^?#]+)(?:\?[^#]*)?(?:#L(\d+)(?:-L(\d+))?)?$"
    ).ok()?;

    let caps = re.captures(url)?;

    Some(GitHubLink {
        owner: caps.get(1)?.as_str().to_string(),
        repo: caps.get(2)?.as_str().to_string(),
        branch: caps.get(3)?.as_str().to_string(),
        path: caps.get(4)?.as_str().to_string(),
        start_line: caps.get(5).and_then(|m| m.as_str().parse().ok()),
        end_line: caps.get(6).and_then(|m| m.as_str().parse().ok()),
        original_url: url.to_string(),
    })
}

/// Fetch code from raw.githubusercontent.com
fn fetch_github_code(link: &GitHubLink) -> Result<String, String> {
    let raw_url = format!(
        "https://raw.githubusercontent.com/{}/{}/{}/{}",
        link.owner, link.repo, link.branch, link.path
    );

    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(5)))
        .build()
        .new_agent();

    let response = agent
        .get(&raw_url)
        .call()
        .map_err(|e| e.to_string())?;

    response.into_body().read_to_string().map_err(|e| e.to_string())
}

/// Extract specified line range from code
fn extract_lines(code: &str, start: usize, end: usize) -> String {
    code.lines()
        .enumerate()
        .filter(|(i, _)| *i + 1 >= start && *i < end)
        .map(|(_, line)| line)
        .collect::<Vec<_>>()
        .join("\n")
}

/// Detect file extension and return language for syntax highlighting
fn detect_language(path: &str) -> &str {
    let ext = path.rsplit('.').next().unwrap_or("");
    match ext {
        "rs" => "rust",
        "js" => "javascript",
        "ts" => "typescript",
        "tsx" => "tsx",
        "jsx" => "jsx",
        "py" => "python",
        "rb" => "ruby",
        "go" => "go",
        "java" => "java",
        "c" => "c",
        "cpp" | "cc" | "cxx" => "cpp",
        "h" | "hpp" => "cpp",
        "cs" => "csharp",
        "php" => "php",
        "swift" => "swift",
        "kt" | "kts" => "kotlin",
        "scala" => "scala",
        "sh" | "bash" => "bash",
        "zsh" => "zsh",
        "fish" => "fish",
        "ps1" => "powershell",
        "sql" => "sql",
        "html" => "html",
        "css" => "css",
        "scss" => "scss",
        "sass" => "sass",
        "less" => "less",
        "json" => "json",
        "yaml" | "yml" => "yaml",
        "toml" => "toml",
        "xml" => "xml",
        "md" | "markdown" => "markdown",
        "dockerfile" => "dockerfile",
        "makefile" => "makefile",
        "cmake" => "cmake",
        "vim" => "vim",
        "lua" => "lua",
        "r" => "r",
        "pl" | "pm" => "perl",
        "ex" | "exs" => "elixir",
        "erl" | "hrl" => "erlang",
        "hs" => "haskell",
        "ml" | "mli" => "ocaml",
        "fs" | "fsx" => "fsharp",
        "clj" | "cljs" => "clojure",
        "lisp" | "cl" => "lisp",
        "el" => "elisp",
        "zig" => "zig",
        "nim" => "nim",
        "v" => "v",
        "d" => "d",
        "dart" => "dart",
        "groovy" => "groovy",
        "tf" | "tfvars" => "hcl",
        "graphql" | "gql" => "graphql",
        "proto" => "protobuf",
        "asm" | "s" => "asm",
        "nix" => "nix",
        _ => "",
    }
}

/// GitHub SVG icon
const GITHUB_ICON: &str = r#"<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>"#;

/// Render GitHub embed HTML
fn render_github_embed(link: &GitHubLink, highlighted_code: &str, _raw_code: &str) -> String {
    let lines_text = match (link.start_line, link.end_line) {
        (Some(start), Some(end)) => format!("L{start}-L{end}"),
        (Some(start), None) => format!("L{start}"),
        _ => String::new(),
    };

    // Shorten revision (first 7 chars for commit hashes)
    let short_rev = if link.branch.len() > 7 && link.branch.chars().all(|c| c.is_ascii_hexdigit()) {
        &link.branch[..7]
    } else {
        &link.branch
    };

    // Copy button is added dynamically by frontend JavaScript to the code block
    format!(
        r#"<div class="github-embed-card">
<div class="github-embed-header">
<div class="github-embed-info">
<div class="github-embed-row">
{icon}
<a href="{url}" target="_blank" rel="noopener noreferrer">
<span class="github-embed-path">{full_path}</span>
</a>
{lines}
</div>
<div class="github-embed-row">
<span class="github-embed-rev">{rev}</span>
</div>
</div>
</div>
<div class="github-embed-code">
{code}
</div>
</div>"#,
        icon = GITHUB_ICON,
        url = html_escape(&link.original_url),
        full_path = html_escape(&link.path),
        rev = html_escape(short_rev),
        lines = if lines_text.is_empty() {
            String::new()
        } else {
            format!(r#"<span class="github-embed-lines">{lines_text}</span>"#)
        },
        code = highlighted_code
    )
}

/// Process GitHub embeds in markdown
/// Only processes standalone GitHub links at the start of a line
fn process_github_embeds(markdown: &str, converter: &MarkdownConverter) -> String {
    let mut result = String::new();
    let mut in_code_block = false;

    for line in markdown.lines() {
        // Track code block state
        if line.starts_with("```") {
            in_code_block = !in_code_block;
            result.push_str(line);
            result.push('\n');
            continue;
        }

        if in_code_block {
            result.push_str(line);
            result.push('\n');
            continue;
        }

        let trimmed = line.trim();

        // Check if line is a standalone GitHub blob URL (not part of a markdown link)
        if trimmed.starts_with("https://github.com/") && trimmed.contains("/blob/")
            && !line.contains('[') && !line.contains('(')
            && let Some(link) = parse_github_link(trimmed)
        {
            // Try to fetch and render the code
            match fetch_github_code(&link) {
                Ok(code) => {
                    let code_to_render = match (link.start_line, link.end_line) {
                        (Some(start), Some(end)) => extract_lines(&code, start, end),
                        (Some(start), None) => extract_lines(&code, start, start),
                        _ => code,
                    };

                    // Apply syntax highlighting using syntect
                    let lang = detect_language(&link.path);
                    let highlighted = converter.highlight_code(&code_to_render, lang);
                    let embed_html = render_github_embed(&link, &highlighted, &code_to_render);
                    result.push_str(&embed_html);
                    result.push('\n');
                    continue;
                }
                Err(_) => {
                    // Fallback: keep original link
                    result.push_str(line);
                    result.push('\n');
                    continue;
                }
            }
        }

        result.push_str(line);
        result.push('\n');
    }

    // Remove trailing newline if original didn't have one
    if !markdown.ends_with('\n') && result.ends_with('\n') {
        result.pop();
    }

    result
}

/// Process code blocks with filename syntax (e.g., ```json:package.json)
/// Converts them to custom HTML before comrak processing
fn process_code_blocks_with_filename(markdown: &str, converter: &MarkdownConverter) -> String {
    let mut result = String::new();
    let mut in_code_block = false;
    let mut code_block_info: Option<(String, String)> = None; // (lang, filename)
    let mut code_content = String::new();

    let lines: Vec<&str> = markdown.lines().collect();
    for (i, line) in lines.iter().enumerate() {
        if line.starts_with("```") && !in_code_block {
            let info = line.trim_start_matches('`').trim();
            if let Some((lang, filename)) = parse_code_info(info) {
                // Start of code block with filename
                in_code_block = true;
                code_block_info = Some((lang.to_string(), filename.to_string()));
                code_content.clear();
                continue;
            }
            // Normal code block without filename - pass through
            result.push_str(line);
            if i < lines.len() - 1 {
                result.push('\n');
            }
            in_code_block = true;
            continue;
        }

        if line.starts_with("```") && in_code_block {
            if let Some((lang, filename)) = code_block_info.take() {
                // End of code block with filename - render custom HTML
                // Remove trailing newline from code content
                let code = code_content.trim_end_matches('\n');
                let highlighted = converter.highlight_code(code, &lang);
                result.push_str(&render_code_block_with_filename(&filename, &highlighted));
                if i < lines.len() - 1 {
                    result.push('\n');
                }
            } else {
                // End of normal code block - pass through
                result.push_str(line);
                if i < lines.len() - 1 {
                    result.push('\n');
                }
            }
            in_code_block = false;
            continue;
        }

        if in_code_block && code_block_info.is_some() {
            // Inside code block with filename - collect content
            code_content.push_str(line);
            code_content.push('\n');
        } else {
            // Outside code block or inside normal code block - pass through
            result.push_str(line);
            if i < lines.len() - 1 {
                result.push('\n');
            }
        }
    }

    result
}

/// HTML escape for XSS prevention
fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Parse code info string to extract language and filename
/// e.g., "json:package.json" -> Some(("json", "package.json"))
/// e.g., "rust" -> None (no filename)
fn parse_code_info(info: &str) -> Option<(&str, &str)> {
    let (lang, filename) = info.split_once(':')?;
    if lang.is_empty() || filename.is_empty() {
        return None;
    }
    Some((lang, filename))
}

/// Render code block with filename header (copy button added by frontend)
fn render_code_block_with_filename(filename: &str, highlighted_code: &str) -> String {
    // highlighted_code already contains <pre style="..."><code>...</code></pre> from syntect
    // Copy button is added dynamically by frontend JavaScript
    format!(
        r#"<div class="code-block-container"><div class="code-block-filename-container"><span class="code-block-filename">{filename}</span></div>{highlighted}</div>"#,
        filename = html_escape(filename),
        highlighted = highlighted_code
    )
}

/// Escape angle brackets that look like HTML tags but are not valid HTML
/// This preserves intentional HTML while escaping things like <script> in headings
///
/// Issue: Article 01ev3p1knggn1wwsg0n0e98915 had headings like `## lerna run <script>`
/// where `<script>` and `<subcommand>` were being interpreted as HTML tags and disappeared.
/// This function escapes invalid HTML-like tags while preserving valid HTML.
fn escape_invalid_html_tags(markdown: &str) -> String {
    let mut result = String::new();
    let mut in_code_block = false;
    let mut in_inline_code = false;

    let lines: Vec<&str> = markdown.lines().collect();
    for (i, line) in lines.iter().enumerate() {
        // Track code block state
        if line.starts_with("```") {
            in_code_block = !in_code_block;
            result.push_str(line);
            if i < lines.len() - 1 {
                result.push('\n');
            }
            continue;
        }

        if in_code_block {
            result.push_str(line);
            if i < lines.len() - 1 {
                result.push('\n');
            }
            continue;
        }

        // Process line character by character
        let chars: Vec<char> = line.chars().collect();
        let mut j = 0;
        while j < chars.len() {
            let ch = chars[j];

            // Track inline code
            if ch == '`' {
                in_inline_code = !in_inline_code;
                result.push(ch);
                j += 1;
                continue;
            }

            if in_inline_code {
                result.push(ch);
                j += 1;
                continue;
            }

            // Check for angle bracket pattern
            if ch == '<' {
                // Find closing >
                let start = j;
                j += 1;
                let mut tag_content = String::new();
                while j < chars.len() && chars[j] != '>' {
                    tag_content.push(chars[j]);
                    j += 1;
                }

                if j < chars.len() && chars[j] == '>' {
                    // Check if it's a valid HTML tag or our custom embed
                    let is_valid_html = is_valid_html_tag(&tag_content);
                    if is_valid_html {
                        // Keep as-is
                        result.push('<');
                        result.push_str(&tag_content);
                        result.push('>');
                    } else {
                        // Escape
                        result.push_str("&lt;");
                        result.push_str(&tag_content);
                        result.push_str("&gt;");
                    }
                    j += 1;
                } else {
                    // No closing >, just push the <
                    result.push('<');
                    j = start + 1;
                }
            } else {
                result.push(ch);
                j += 1;
            }
        }

        if i < lines.len() - 1 {
            result.push('\n');
        }
    }

    result
}

/// Check if a tag content represents a valid HTML tag
fn is_valid_html_tag(content: &str) -> bool {
    let content = content.trim();
    if content.is_empty() {
        return false;
    }

    // Handle closing tags
    let tag_name = if let Some(stripped) = content.strip_prefix('/') {
        stripped
    } else {
        content.split_whitespace().next().unwrap_or("")
    };

    // Remove any attributes for comparison
    let tag_name = tag_name.split([' ', '/', '>']).next().unwrap_or("");

    // List of common valid HTML tags
    let valid_tags = [
        "a", "abbr", "address", "area", "article", "aside", "audio",
        "b", "base", "bdi", "bdo", "blockquote", "body", "br", "button",
        "canvas", "caption", "cite", "code", "col", "colgroup",
        "data", "datalist", "dd", "del", "details", "dfn", "dialog", "div", "dl", "dt",
        "em", "embed",
        "fieldset", "figcaption", "figure", "footer", "form",
        "h1", "h2", "h3", "h4", "h5", "h6", "head", "header", "hgroup", "hr", "html",
        "i", "iframe", "img", "input", "ins",
        "kbd",
        "label", "legend", "li", "link",
        "main", "map", "mark", "menu", "meta", "meter",
        "nav", "noscript",
        "object", "ol", "optgroup", "option", "output",
        "p", "picture", "pre", "progress",
        "q",
        "rp", "rt", "ruby",
        "s", "samp", "section", "select", "slot", "small", "source", "span", "strong", "style", "sub", "summary", "sup", "svg",
        "table", "tbody", "td", "template", "textarea", "tfoot", "th", "thead", "time", "title", "tr", "track",
        "u", "ul",
        "var", "video",
        "wbr",
        // Also allow common self-closing patterns
        "!--", "!DOCTYPE",
    ];

    valid_tags.iter().any(|&t| tag_name.eq_ignore_ascii_case(t))
}

/// Preprocess markdown to handle custom embed syntax
fn preprocess_embeds(markdown: &str) -> String {
    // SpeakerDeck: @[sd](slideId,slideNo,aspectRatio,dataRatio)
    let sd_re = Regex::new(r"@\[sd\]\(([^,]+),([^,]*),([^,]+),([^)]+)\)").unwrap();

    sd_re
        .replace_all(markdown, |caps: &regex::Captures| {
            let slide_id = &caps[1];
            let slide_no = &caps[2];
            let aspect_ratio = &caps[3];
            let data_ratio = &caps[4];

            let src = if slide_no.is_empty() {
                format!("https://speakerdeck.com/player/{slide_id}")
            } else {
                format!("https://speakerdeck.com/player/{slide_id}?slide={slide_no}")
            };

            format!(
                r#"<div class="block-embed-service-speakerdeck"><iframe class="speakerdeck-iframe" frameborder="0" src="{src}" allowfullscreen="true" style="border: 0px; background: padding-box padding-box rgba(0, 0, 0, 0.1); margin: 0px; padding: 0px; border-radius: 6px; box-shadow: rgba(0, 0, 0, 0.2) 0px 5px 40px; width: 100%; height: auto; aspect-ratio: {aspect_ratio};" data-ratio="{data_ratio}"></iframe></div>"#
            )
        })
        .to_string()
}

/// Process custom container syntax (:::details, :::message)
fn process_containers<F>(markdown: &str, convert_inner: F) -> String
where
    F: Fn(&str) -> String,
{
    let container_re = Regex::new(r"(?s):::[ \t]*(details|message)[ \t]*([^\n]*)\n(.*?):::").unwrap();

    container_re
        .replace_all(markdown, |caps: &regex::Captures| {
            let container_type = &caps[1];
            let argument = caps[2].trim();
            let inner_content = &caps[3];

            // Convert inner markdown content
            let inner_html = convert_inner(inner_content);

            // Generate container HTML (preserve trailing newline for legacy compatibility)
            match container_type {
                "details" => format!(
                    "<details><summary>{}</summary><div class=\"details-content\">{}</div></details>\n",
                    html_escape(argument),
                    inner_html
                ),
                "message" => format!(
                    "<div class=\"message {}\">{}</div>\n",
                    html_escape(argument),
                    inner_html
                ),
                _ => caps[0].to_string(),
            }
        })
        .to_string()
}

/// Markdown to HTML converter with syntax highlighting
pub struct MarkdownConverter {
    syntect_adapter: SyntectAdapter,
}

impl Default for MarkdownConverter {
    fn default() -> Self {
        Self::new()
    }
}

impl MarkdownConverter {
    pub fn new() -> Self {
        Self {
            syntect_adapter: SyntectAdapter::new(Some("base16-ocean.dark")),
        }
    }

    pub fn convert(&self, markdown: &str) -> String {
        // Escape invalid HTML-like tags (e.g., <script> in headings)
        let escaped = escape_invalid_html_tags(markdown);

        // Process GitHub embeds (fetch code and render)
        let with_github = process_github_embeds(&escaped, self);

        // Process X embeds (output placeholder divs with tweet IDs)
        let (with_x, _has_x_embed) = process_x_embeds(&with_github);

        // Process link cards (OGP cards) for standalone URLs
        let with_link_cards = process_link_cards(&with_x);

        // Process code blocks with filename (e.g., ```json:package.json)
        let with_code_blocks = process_code_blocks_with_filename(&with_link_cards, self);

        // Preprocess custom embed syntax
        let preprocessed = preprocess_embeds(&with_code_blocks);

        // Process custom containers (:::details, :::message)
        let with_containers = process_containers(&preprocessed, |inner| self.convert_simple(inner));

        // Convert remaining markdown
        let mut html = self.convert_simple(&with_containers);

        // 外部リンクに target="_blank" を追加
        html = self.add_target_blank_to_external_links(&html);

        html
    }

    /// Highlight code using syntect
    fn highlight_code(&self, code: &str, lang: &str) -> String {
        use syntect::highlighting::ThemeSet;
        use syntect::html::highlighted_html_for_string;
        use syntect::parsing::SyntaxSet;

        let ss = SyntaxSet::load_defaults_newlines();
        let ts = ThemeSet::load_defaults();
        let theme = &ts.themes["base16-ocean.dark"];

        let syntax = ss
            .find_syntax_by_token(lang)
            .unwrap_or_else(|| ss.find_syntax_plain_text());

        highlighted_html_for_string(code, &ss, syntax, theme).unwrap_or_else(|_| html_escape(code))
    }

    /// Simple conversion without container processing (used for inner content)
    fn convert_simple(&self, markdown: &str) -> String {
        let mut options = Options::default();

        // Enable extensions
        options.extension.strikethrough = true;
        options.extension.table = true;
        options.extension.autolink = true;
        options.extension.tasklist = true;
        options.extension.header_ids = Some("".to_string());

        // Render options
        options.render.r#unsafe = true; // Allow raw HTML (for custom embeds)
        options.render.github_pre_lang = true;

        let mut plugins = comrak::options::Plugins::default();
        plugins.render.codefence_syntax_highlighter = Some(&self.syntect_adapter);

        comrak::markdown_to_html_with_plugins(markdown, &options, &plugins)
    }

    fn add_target_blank_to_external_links(&self, html: &str) -> String {
        let re = Regex::new(r#"<a href="(https?://[^"]*)""#).unwrap();
        re.replace_all(html, r#"<a href="$1" target="_blank" rel="noopener noreferrer""#)
            .to_string()
    }
}

/// Convert markdown to HTML (convenience function)
pub fn convert_markdown_to_html(markdown: &str) -> String {
    let converter = MarkdownConverter::new();
    converter.convert(markdown)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_basic_markdown() {
        let markdown = "# Hello\n\nThis is **bold** and *italic*.";
        let html = convert_markdown_to_html(markdown);
        assert!(html.contains("<h1"));
        assert!(html.contains("<strong>bold</strong>"));
        assert!(html.contains("<em>italic</em>"));
    }

    #[test]
    fn test_code_block() {
        let markdown = "```rust\nfn main() {}\n```";
        let html = convert_markdown_to_html(markdown);
        assert!(html.contains("<pre"));
        assert!(html.contains("<code"));
    }

    #[test]
    fn test_speakerdeck_embed() {
        let markdown = "@[sd](abc123,1,560/315,1.78)";
        let html = convert_markdown_to_html(markdown);
        assert!(html.contains("block-embed-service-speakerdeck"));
        assert!(html.contains("speakerdeck.com/player/abc123?slide=1"));
        assert!(html.contains("aspect-ratio: 560/315"));
        assert!(html.contains("data-ratio=\"1.78\""));
    }

    #[test]
    fn test_speakerdeck_embed_no_slide_number() {
        let markdown = "@[sd](abc123,,560/315,1.78)";
        let html = convert_markdown_to_html(markdown);
        assert!(html.contains("speakerdeck.com/player/abc123\""));
        assert!(!html.contains("?slide="));
    }

    #[test]
    fn test_external_link_target_blank() {
        let markdown = "[Example](https://example.com)";
        let html = convert_markdown_to_html(markdown);
        assert!(html.contains(r#"target="_blank""#));
        assert!(html.contains(r#"rel="noopener noreferrer""#));
    }

    #[test]
    fn test_internal_link_no_target_blank() {
        let markdown = "[Internal](/path/to/page)";
        let html = convert_markdown_to_html(markdown);
        assert!(!html.contains(r#"target="_blank""#));
    }

    #[test]
    fn test_details_container() {
        let markdown = "::: details sourceCode\nhere be dragons\n:::";
        let html = convert_markdown_to_html(markdown);
        assert_eq!(
            html,
            "<details><summary>sourceCode</summary><div class=\"details-content\"><p>here be dragons</p>\n</div></details>\n"
        );
    }

    #[test]
    fn test_message_container_info() {
        let markdown = "::: message info\nhere be dragons\n:::";
        let html = convert_markdown_to_html(markdown);
        assert_eq!(
            html,
            "<div class=\"message info\"><p>here be dragons</p>\n</div>\n"
        );
    }

    #[test]
    fn test_message_container_warn() {
        let markdown = "::: message warn\nhere be dragons\n:::";
        let html = convert_markdown_to_html(markdown);
        assert_eq!(
            html,
            "<div class=\"message warn\"><p>here be dragons</p>\n</div>\n"
        );
    }

    #[test]
    fn test_message_container_error() {
        let markdown = "::: message error\nhere be dragons\n:::";
        let html = convert_markdown_to_html(markdown);
        assert_eq!(
            html,
            "<div class=\"message error\"><p>here be dragons</p>\n</div>\n"
        );
    }

    #[test]
    fn test_message_container_tips() {
        let markdown = "::: message tips\nhere be dragons\n:::";
        let html = convert_markdown_to_html(markdown);
        assert_eq!(
            html,
            "<div class=\"message tips\"><p>here be dragons</p>\n</div>\n"
        );
    }

    #[test]
    fn test_details_xss_prevention() {
        let markdown = "::: details <script>alert('xss')</script>\ntest\n:::";
        let html = convert_markdown_to_html(markdown);
        assert!(!html.contains("<script>"));
        assert!(html.contains("&amp;lt;script&amp;gt;"));
    }

    #[test]
    fn test_message_container_no_argument() {
        let markdown = ":::message\nhere be dragons\n:::";
        let html = convert_markdown_to_html(markdown);
        assert_eq!(
            html,
            "<div class=\"message \"><p>here be dragons</p>\n</div>\n"
        );
    }

    #[test]
    fn test_angle_brackets_in_heading() {
        let markdown = "## lerna run <script>";
        let html = convert_markdown_to_html(markdown);
        assert!(html.contains("&lt;script&gt;"));
        assert!(!html.contains("<script>"));
    }

    #[test]
    fn test_angle_brackets_in_text() {
        let markdown = "Use the `yarn build <subcommand>` command.";
        let html = convert_markdown_to_html(markdown);
        assert!(html.contains("&lt;subcommand&gt;"));
    }

    #[test]
    fn test_parse_github_link_with_lines() {
        let url = "https://github.com/owner/repo/blob/main/src/lib.rs#L10-L20";
        let link = parse_github_link(url).unwrap();
        assert_eq!(link.owner, "owner");
        assert_eq!(link.repo, "repo");
        assert_eq!(link.branch, "main");
        assert_eq!(link.path, "src/lib.rs");
        assert_eq!(link.start_line, Some(10));
        assert_eq!(link.end_line, Some(20));
    }

    #[test]
    fn test_parse_github_link_with_plain_param() {
        let url = "https://github.com/owner/repo/blob/abc123/path/to/file.rs?plain=1#L5-L15";
        let link = parse_github_link(url).unwrap();
        assert_eq!(link.owner, "owner");
        assert_eq!(link.repo, "repo");
        assert_eq!(link.branch, "abc123");
        assert_eq!(link.path, "path/to/file.rs");
        assert_eq!(link.start_line, Some(5));
        assert_eq!(link.end_line, Some(15));
    }

    #[test]
    fn test_parse_github_link_single_line() {
        let url = "https://github.com/owner/repo/blob/main/file.rs#L42";
        let link = parse_github_link(url).unwrap();
        assert_eq!(link.start_line, Some(42));
        assert_eq!(link.end_line, None);
    }

    #[test]
    fn test_parse_github_link_no_lines() {
        let url = "https://github.com/owner/repo/blob/main/file.rs";
        let link = parse_github_link(url).unwrap();
        assert_eq!(link.start_line, None);
        assert_eq!(link.end_line, None);
    }

    #[test]
    fn test_extract_lines() {
        let code = "line1\nline2\nline3\nline4\nline5";
        let extracted = extract_lines(code, 2, 4);
        assert_eq!(extracted, "line2\nline3\nline4");
    }

    #[test]
    fn test_detect_language() {
        assert_eq!(detect_language("file.rs"), "rust");
        assert_eq!(detect_language("file.ts"), "typescript");
        assert_eq!(detect_language("path/to/file.py"), "python");
        assert_eq!(detect_language("file.unknown"), "");
    }

    #[test]
    fn test_github_embed_not_in_code_block() {
        let markdown = "```\nhttps://github.com/owner/repo/blob/main/file.rs#L1-L5\n```";
        let converter = MarkdownConverter::new();
        let result = process_github_embeds(markdown, &converter);
        // Should not be processed (inside code block)
        assert!(result.contains("https://github.com/owner/repo/blob/main/file.rs#L1-L5"));
        assert!(!result.contains("github-embed-card"));
    }

    #[test]
    fn test_github_link_in_markdown_link_not_processed() {
        let markdown = "[link](https://github.com/owner/repo/blob/main/file.rs)";
        let converter = MarkdownConverter::new();
        let result = process_github_embeds(markdown, &converter);
        // Should not be processed (inside markdown link)
        assert!(!result.contains("github-embed-card"));
    }

    #[test]
    fn test_parse_code_info() {
        assert_eq!(parse_code_info("json:package.json"), Some(("json", "package.json")));
        assert_eq!(parse_code_info("rust:src/main.rs"), Some(("rust", "src/main.rs")));
        assert_eq!(parse_code_info("typescript:index.ts"), Some(("typescript", "index.ts")));
        assert_eq!(parse_code_info("json"), None);
        assert_eq!(parse_code_info(":filename"), None);
        assert_eq!(parse_code_info("lang:"), None);
        assert_eq!(parse_code_info(""), None);
    }

    #[test]
    fn test_code_block_with_filename() {
        let markdown = "```json:package.json\n{\"name\": \"test\"}\n```";
        let html = convert_markdown_to_html(markdown);
        assert!(html.contains("code-block-filename-container"));
        assert!(html.contains("code-block-filename"));
        assert!(html.contains("package.json"));
        assert!(html.contains("code-block-container"));
        assert!(html.contains("<pre")); // syntect generates <pre style="...">
        // Copy button is added by frontend JavaScript
    }

    #[test]
    fn test_code_block_without_filename() {
        let markdown = "```json\n{\"name\": \"test\"}\n```";
        let html = convert_markdown_to_html(markdown);
        // Without filename, should not have filename container
        assert!(!html.contains("code-block-filename-container"));
        assert!(!html.contains("code-block-container"));
    }

    #[test]
    fn test_code_block_filename_xss() {
        let markdown = "```json:<script>alert('xss')</script>\n{}\n```";
        let html = convert_markdown_to_html(markdown);
        assert!(!html.contains("<script>alert"));
        assert!(html.contains("&lt;script&gt;"));
    }

    #[test]
    fn test_code_block_with_filename_multiline() {
        let markdown = "```rust:src/main.rs\nfn main() {\n    println!(\"Hello\");\n}\n```";
        let html = convert_markdown_to_html(markdown);
        assert!(html.contains("code-block-filename-container"));
        assert!(html.contains("src/main.rs"));
        assert!(html.contains("<pre")); // syntect generates <pre style="...">
    }

    // Link Card (OGP) tests

    #[test]
    fn test_is_standalone_url() {
        assert!(is_standalone_url("https://example.com"));
        assert!(is_standalone_url("http://example.com"));
        assert!(is_standalone_url("  https://example.com  "));
        assert!(!is_standalone_url("[link](https://example.com)"));
        assert!(!is_standalone_url("Check this: https://example.com"));
        assert!(!is_standalone_url("not a url"));
    }

    #[test]
    fn test_is_github_blob_url() {
        assert!(is_github_blob_url("https://github.com/owner/repo/blob/main/file.rs"));
        assert!(!is_github_blob_url("https://github.com/owner/repo"));
        assert!(!is_github_blob_url("https://example.com"));
    }

    #[test]
    fn test_extract_domain() {
        assert_eq!(extract_domain("https://example.com/path"), "example.com");
        assert_eq!(extract_domain("https://sub.example.com"), "sub.example.com");
        assert_eq!(extract_domain("invalid"), "invalid");
    }

    #[test]
    fn test_resolve_url_absolute() {
        assert_eq!(
            resolve_url("https://example.com", "https://other.com/image.png"),
            "https://other.com/image.png"
        );
    }

    #[test]
    fn test_resolve_url_relative() {
        assert_eq!(
            resolve_url("https://example.com/page", "/favicon.ico"),
            "https://example.com/favicon.ico"
        );
        assert_eq!(
            resolve_url("https://example.com/dir/page", "image.png"),
            "https://example.com/dir/image.png"
        );
    }

    #[test]
    fn test_parse_ogp() {
        let html = r#"
        <!DOCTYPE html>
        <html>
        <head>
            <meta property="og:title" content="Test Title">
            <meta property="og:description" content="Test Description">
            <meta property="og:image" content="https://example.com/image.png">
            <link rel="icon" href="/favicon.ico">
        </head>
        <body></body>
        </html>
        "#;
        let ogp = parse_ogp(html, "https://example.com");
        assert_eq!(ogp.title, "Test Title");
        assert_eq!(ogp.description, Some("Test Description".to_string()));
        assert_eq!(ogp.image, Some("https://example.com/image.png".to_string()));
        assert_eq!(ogp.favicon, Some("https://example.com/favicon.ico".to_string()));
    }

    #[test]
    fn test_parse_ogp_fallback_to_title_tag() {
        let html = r#"
        <!DOCTYPE html>
        <html>
        <head>
            <title>Fallback Title</title>
            <meta name="description" content="Fallback Description">
        </head>
        <body></body>
        </html>
        "#;
        let ogp = parse_ogp(html, "https://example.com");
        assert_eq!(ogp.title, "Fallback Title");
        assert_eq!(ogp.description, Some("Fallback Description".to_string()));
    }

    #[test]
    fn test_render_link_card() {
        let ogp = OgpInfo {
            url: "https://example.com".to_string(),
            title: "Test Title".to_string(),
            description: Some("Test Description".to_string()),
            image: Some("https://example.com/image.png".to_string()),
            favicon: Some("https://example.com/favicon.ico".to_string()),
        };
        let html = render_link_card(&ogp);
        assert!(html.contains("link-card"));
        assert!(html.contains("Test Title"));
        assert!(html.contains("Test Description"));
        assert!(html.contains("link-card-image"));
        assert!(html.contains("link-card-favicon"));
        assert!(html.contains("example.com"));
        assert!(html.contains(r#"target="_blank""#));
    }

    #[test]
    fn test_render_link_card_without_image() {
        let ogp = OgpInfo {
            url: "https://example.com".to_string(),
            title: "Test Title".to_string(),
            description: None,
            image: None,
            favicon: None,
        };
        let html = render_link_card(&ogp);
        assert!(html.contains("link-card"));
        assert!(html.contains("Test Title"));
        assert!(!html.contains("link-card-image"));
        assert!(!html.contains("link-card-description"));
    }

    #[test]
    fn test_link_card_xss_prevention() {
        let ogp = OgpInfo {
            url: "https://example.com".to_string(),
            title: "<script>alert('xss')</script>".to_string(),
            description: Some("<img onerror='alert(1)'>".to_string()),
            image: None,
            favicon: None,
        };
        let html = render_link_card(&ogp);
        // Angle brackets should be escaped
        assert!(!html.contains("<script>"));
        assert!(!html.contains("<img"));
        assert!(html.contains("&lt;script&gt;"));
        assert!(html.contains("&lt;img"));
    }

    #[test]
    fn test_link_cards_not_in_code_block() {
        let markdown = "```\nhttps://example.com\n```";
        let result = process_link_cards(markdown);
        // Should not be processed (inside code block)
        assert!(result.contains("https://example.com"));
        assert!(!result.contains("link-card"));
    }

    #[test]
    fn test_link_cards_skip_localhost() {
        let markdown = "https://localhost:3000/test";
        let result = process_link_cards(markdown);
        // Should not be processed (localhost)
        assert!(result.contains("https://localhost:3000/test"));
        assert!(!result.contains("link-card"));
    }

    #[test]
    fn test_link_cards_skip_github_blob() {
        let markdown = "https://github.com/owner/repo/blob/main/file.rs";
        let result = process_link_cards(markdown);
        // Should not be processed (GitHub blob - handled by GitHub embed)
        assert!(result.contains("https://github.com/owner/repo/blob/main/file.rs"));
        assert!(!result.contains("link-card"));
    }

    // X embed tests

    #[test]
    fn test_is_x_url() {
        assert!(is_x_url("https://x.com/user/status/1234567890"));
        assert!(is_x_url("https://x.com/user/status/1234567890?s=20"));
        assert!(!is_x_url("https://x.com/user"));
        assert!(!is_x_url("https://twitter.com/user/status/1234567890"));
        assert!(!is_x_url("https://example.com"));
    }

    #[test]
    fn test_extract_x_tweet_id() {
        assert_eq!(
            extract_x_tweet_id("https://x.com/user/status/1234567890"),
            Some("1234567890")
        );
        assert_eq!(
            extract_x_tweet_id("https://x.com/user/status/1234567890?s=20"),
            Some("1234567890")
        );
        assert_eq!(extract_x_tweet_id("https://x.com/user"), None);
    }

    #[test]
    fn test_x_embed_produces_placeholder() {
        let markdown = "https://x.com/user/status/1234567890";
        let (result, has_embed) = process_x_embeds(markdown);
        assert!(result.contains("<div data-tweet-id=\"1234567890\"></div>"));
        assert!(has_embed);
    }

    #[test]
    fn test_x_embed_not_in_code_block() {
        let markdown = "```\nhttps://x.com/user/status/1234567890\n```";
        let (result, has_embed) = process_x_embeds(markdown);
        // Should not be processed (inside code block)
        assert!(result.contains("https://x.com/user/status/1234567890"));
        assert!(!has_embed);
    }

    #[test]
    fn test_x_url_in_markdown_link_not_processed() {
        let markdown = "[link](https://x.com/user/status/1234567890)";
        let (result, has_embed) = process_x_embeds(markdown);
        // Should not be processed (inside markdown link)
        assert!(result.contains("[link](https://x.com/user/status/1234567890)"));
        assert!(!has_embed);
    }

    #[test]
    fn test_link_cards_skip_x_url() {
        let markdown = "https://x.com/user/status/1234567890";
        let result = process_link_cards(markdown);
        // Should not be processed (X URL - handled by X embed)
        assert!(result.contains("https://x.com/user/status/1234567890"));
        assert!(!result.contains("link-card"));
    }
}
