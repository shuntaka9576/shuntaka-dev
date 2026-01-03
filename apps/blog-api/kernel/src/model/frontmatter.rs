use serde::Deserialize;

/// Markdown frontmatter structure
#[derive(Debug, Clone, Deserialize)]
pub struct ArticleFrontmatter {
    pub title: String,
    #[serde(rename = "type")]
    pub article_type: String,
    pub description: Option<String>,
    pub thumbnail: Option<String>,
    #[serde(default)]
    pub publish: bool,
    #[serde(default)]
    pub tags: Vec<String>,
}

impl ArticleFrontmatter {
    /// Parse frontmatter from markdown content
    /// Returns (frontmatter, content_without_frontmatter)
    pub fn parse(markdown: &str) -> Result<(Self, String), FrontmatterError> {
        let trimmed = markdown.trim_start();

        if !trimmed.starts_with("---") {
            return Err(FrontmatterError::NotFound);
        }

        // Find the closing ---
        let rest = &trimmed[3..];
        let end_pos = rest
            .find("\n---")
            .ok_or(FrontmatterError::UnclosedDelimiter)?;

        let yaml_content = &rest[..end_pos].trim();
        let content = &rest[end_pos + 4..].trim_start();

        let frontmatter: ArticleFrontmatter =
            serde_yaml::from_str(yaml_content).map_err(FrontmatterError::YamlParse)?;

        Ok((frontmatter, content.to_string()))
    }
}

#[derive(Debug, thiserror::Error)]
pub enum FrontmatterError {
    #[error("Frontmatter not found")]
    NotFound,

    #[error("Unclosed frontmatter delimiter")]
    UnclosedDelimiter,

    #[error("YAML parse error: {0}")]
    YamlParse(#[from] serde_yaml::Error),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_frontmatter() {
        let markdown = r#"---
title: "Test Article"
type: "tech"
description: "A test article"
publish: true
tags:
  - rust
  - api
---

# Hello World

This is the content.
"#;

        let (frontmatter, content) = ArticleFrontmatter::parse(markdown).unwrap();

        assert_eq!(frontmatter.title, "Test Article");
        assert_eq!(frontmatter.article_type, "tech");
        assert_eq!(frontmatter.description, Some("A test article".to_string()));
        assert!(frontmatter.publish);
        assert_eq!(frontmatter.tags, vec!["rust", "api"]);
        assert!(content.starts_with("# Hello World"));
    }

    #[test]
    fn test_parse_frontmatter_no_frontmatter() {
        let markdown = "# Hello World\n\nThis is content without frontmatter.";

        let result = ArticleFrontmatter::parse(markdown);
        assert!(matches!(result, Err(FrontmatterError::NotFound)));
    }
}
