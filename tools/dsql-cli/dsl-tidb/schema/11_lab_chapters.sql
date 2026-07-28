-- lab_chapters (labs の章)。labs/<lab-slug>/<chapter-slug>.mdx を同期する。
-- position は config.yaml の chapters 配列順。content_html は articles と同様
-- 同期時に markdown crate で事前生成する (:::widget はプレースホルダ div になる)。
-- 設計は docs/source/98_tasks/2026-07-28-labs-feature/index.md を参照。
CREATE TABLE IF NOT EXISTS `${SCHEMA}`.`lab_chapters` (
  `chapter_id`   CHAR(36)     NOT NULL DEFAULT (UUID()),
  `lab_id`       CHAR(36)     NOT NULL,
  `slug`         VARCHAR(255) NOT NULL,             -- ファイル名から拡張子を除いたもの
  `title`        VARCHAR(500) NOT NULL,             -- frontmatter の title
  `position`     INT          NOT NULL,             -- config.yaml chapters 配列の添字 (0 始まり)
  `content`      LONGTEXT     NOT NULL,             -- frontmatter を除いた生 Markdown
  `content_html` LONGTEXT     NULL,                 -- 事前生成 HTML (画像 URL 書き換え済み)
  `created_at`   DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`   DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`chapter_id`),
  UNIQUE KEY `uq_lab_chapters_lab_slug` (`lab_id`, `slug`),
  KEY `idx_lab_chapters_lab_position` (`lab_id`, `position`)
);
