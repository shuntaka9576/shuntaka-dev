use comrak::Options;
use comrak::plugins::syntect::SyntectAdapter;
use regex::Regex;

/// HTML escape for XSS prevention
fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
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

        // Preprocess custom embed syntax
        let preprocessed = preprocess_embeds(&escaped);

        // Process custom containers (:::details, :::message)
        let with_containers = process_containers(&preprocessed, |inner| self.convert_simple(inner));

        // Convert remaining markdown
        let html = self.convert_simple(&with_containers);

        // 外部リンクに target="_blank" を追加
        self.add_target_blank_to_external_links(&html)
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
}
