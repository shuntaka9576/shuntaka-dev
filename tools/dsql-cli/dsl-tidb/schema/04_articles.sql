CREATE TABLE IF NOT EXISTS `${SCHEMA}`.`articles` (
  `article_id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `title` VARCHAR(500) NOT NULL,
  `slug` VARCHAR(255) NOT NULL,
  `user_id` CHAR(36) NOT NULL,
  `content` LONGTEXT NOT NULL,
  `thumbnail` TEXT NULL,
  `description` TEXT NOT NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'draft',
  `type` VARCHAR(50) NULL,
  `published_at` DATETIME(6) NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`article_id`),
  UNIQUE KEY `uq_articles_slug` (`slug`),
  KEY `idx_articles_user_id` (`user_id`),
  KEY `idx_articles_status_published_at` (`status`, `published_at`)
);
-- NOTE: 元の DSQL では status に CHECK 制約 (draft/review/scheduled/published/archived) を
-- かけていた。TiDB は `tidb_enable_check_constraint` がデフォルト OFF で CHECK を書くと
-- "switch of check constraint is off" 警告が出る。当面はアプリ層 (blog-api) で値を
-- バリデーションする方針とし、ここでは CHECK を付けない。
-- TiDB クラスタ単位で有効化する場合は管理者が
--   SET GLOBAL tidb_enable_check_constraint = ON;
-- を実行したうえで CHECK を別途 ALTER TABLE で追加する。
