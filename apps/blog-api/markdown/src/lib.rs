use comrak::Options;
use comrak::plugins::syntect::SyntectAdapter;
use regex::Regex;
use std::time::Duration;

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
        .filter(|(i, _)| *i + 1 >= start && *i + 1 <= end)
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

/// Copy SVG icon
const COPY_ICON: &str = r#"<svg viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>"#;

/// Check SVG icon (for copy success feedback)
const CHECK_ICON: &str = r#"<svg viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/></svg>"#;

/// Render GitHub embed HTML
fn render_github_embed(link: &GitHubLink, highlighted_code: &str, raw_code: &str) -> String {
    let lines_text = match (link.start_line, link.end_line) {
        (Some(start), Some(end)) => format!("L{}-L{}", start, end),
        (Some(start), None) => format!("L{}", start),
        _ => String::new(),
    };

    let file_name = link.path.rsplit('/').next().unwrap_or(&link.path);

    format!(
        r#"<div class="github-embed-card">
<div class="github-embed-header">
{icon}
<a href="{url}" target="_blank" rel="noopener noreferrer">
<span class="github-embed-repo">{owner}/{repo}</span>
<span class="github-embed-path">/{path}</span>
</a>
{lines}
<button class="github-embed-copy" data-code="{raw_code}" aria-label="Copy code">
<span class="github-embed-copy-icon">{copy_icon}</span>
<span class="github-embed-check-icon">{check_icon}</span>
</button>
</div>
<div class="github-embed-code">
{code}
</div>
</div>"#,
        icon = GITHUB_ICON,
        url = html_escape(&link.original_url),
        owner = html_escape(&link.owner),
        repo = html_escape(&link.repo),
        path = html_escape(file_name),
        lines = if lines_text.is_empty() {
            String::new()
        } else {
            format!(r#"<span class="github-embed-lines">{}</span>"#, lines_text)
        },
        copy_icon = COPY_ICON,
        check_icon = CHECK_ICON,
        raw_code = html_escape_for_attr(raw_code),
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

        // Check if line is a standalone GitHub blob URL
        if trimmed.starts_with("https://github.com/") && trimmed.contains("/blob/") {
            // Make sure it's not part of a markdown link
            if !line.contains('[') && !line.contains('(') {
                if let Some(link) = parse_github_link(trimmed) {
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

/// HTML escape for XSS prevention
fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// HTML escape for data attributes (includes newlines)
fn html_escape_for_attr(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\n', "&#10;")
        .replace('\r', "&#13;")
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

        // Preprocess custom embed syntax
        let preprocessed = preprocess_embeds(&with_github);

        // Process custom containers (:::details, :::message)
        let with_containers = process_containers(&preprocessed, |inner| self.convert_simple(inner));

        // Convert remaining markdown
        let html = self.convert_simple(&with_containers);

        // 外部リンクに target="_blank" を追加
        self.add_target_blank_to_external_links(&html)
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
}
