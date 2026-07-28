use serde::{Deserialize, Serialize};
use uuid::Uuid;

// ID系のnewtype定義（article.rs のスタイルを踏襲）
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct LabId(Uuid);

impl LabId {
    pub fn new(id: Uuid) -> Self {
        Self(id)
    }

    pub fn as_uuid(&self) -> &Uuid {
        &self.0
    }

    pub fn into_inner(self) -> Uuid {
        self.0
    }
}

/// labs/<lab-slug>/config.yaml の内容。本 (lab) のメタ情報と章の並び順を持つ。
/// chapters の順序がそのまま lab_chapters.position になる。
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct LabConfig {
    pub title: String,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub published: bool,
    #[serde(default)]
    pub chapters: Vec<String>,
}

impl LabConfig {
    pub fn parse(yaml: &str) -> Result<Self, LabConfigError> {
        serde_yaml::from_str(yaml).map_err(LabConfigError::YamlParse)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum LabConfigError {
    #[error("YAML parse error: {0}")]
    YamlParse(#[from] serde_yaml::Error),
}

/// 章ファイル (<slug>.mdx / <slug>.md) の frontmatter。title のみ必須。
/// articles と同じ `---` 区切りの YAML frontmatter を使う。
#[derive(Debug, Clone, Deserialize)]
pub struct ChapterFrontmatter {
    pub title: String,
}

impl ChapterFrontmatter {
    /// Parse frontmatter from markdown content.
    /// Returns (frontmatter, content_without_frontmatter)
    pub fn parse(markdown: &str) -> Result<(Self, String), ChapterFrontmatterError> {
        let trimmed = markdown.trim_start();

        if !trimmed.starts_with("---") {
            return Err(ChapterFrontmatterError::NotFound);
        }

        // Find the closing ---
        let rest = &trimmed[3..];
        let end_pos = rest
            .find("\n---")
            .ok_or(ChapterFrontmatterError::UnclosedDelimiter)?;

        let yaml_content = rest[..end_pos].trim();
        let content = rest[end_pos + 4..].trim_start();

        let frontmatter: ChapterFrontmatter =
            serde_yaml::from_str(yaml_content).map_err(ChapterFrontmatterError::YamlParse)?;

        Ok((frontmatter, content.to_string()))
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ChapterFrontmatterError {
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
    fn test_lab_config_parse_full() {
        let yaml = r#"
title: "DB トランザクション演習"
summary: "OCC / write skew / deadlock などを 3 エンジンで比較するハンズオン"
published: true
chapters:
  - occ
  - write-skew
  - deadlock
"#;
        let config = LabConfig::parse(yaml).unwrap();
        assert_eq!(config.title, "DB トランザクション演習");
        assert_eq!(
            config.summary,
            Some("OCC / write skew / deadlock などを 3 エンジンで比較するハンズオン".to_string())
        );
        assert!(config.published);
        assert_eq!(config.chapters, vec!["occ", "write-skew", "deadlock"]);
    }

    #[test]
    fn test_lab_config_parse_defaults_chapters_empty() {
        let yaml = r#"
title: "空の本"
"#;
        let config = LabConfig::parse(yaml).unwrap();
        assert_eq!(config.title, "空の本");
        assert_eq!(config.summary, None);
        assert!(!config.published);
        assert!(config.chapters.is_empty());
    }

    #[test]
    fn test_lab_config_parse_published_omitted_defaults_false() {
        let yaml = r#"
title: "下書きの本"
chapters:
  - overview
"#;
        let config = LabConfig::parse(yaml).unwrap();
        assert!(!config.published);
        assert_eq!(config.chapters, vec!["overview"]);
    }

    #[test]
    fn test_lab_config_parse_invalid_yaml() {
        let yaml = "title: [unterminated";
        assert!(LabConfig::parse(yaml).is_err());
    }

    #[test]
    fn test_chapter_frontmatter_parse() {
        let markdown = r#"---
title: "楽観的同時実行制御 (OCC)"
---

# OCC

本文
"#;
        let (frontmatter, content) = ChapterFrontmatter::parse(markdown).unwrap();
        assert_eq!(frontmatter.title, "楽観的同時実行制御 (OCC)");
        assert!(content.starts_with("# OCC"));
    }

    #[test]
    fn test_chapter_frontmatter_parse_not_found() {
        let markdown = "# 見出しだけ\n\nfrontmatter がない";
        let result = ChapterFrontmatter::parse(markdown);
        assert!(matches!(result, Err(ChapterFrontmatterError::NotFound)));
    }

    #[test]
    fn test_chapter_frontmatter_parse_unclosed() {
        let markdown = "---\ntitle: \"unclosed\"\n\n# 本文";
        let result = ChapterFrontmatter::parse(markdown);
        assert!(matches!(
            result,
            Err(ChapterFrontmatterError::UnclosedDelimiter)
        ));
    }
}
