-- moments (180字 + 写真必須の一文投稿)。設計は
-- docs/source/98_tasks/2026-07-12-logs-admin-architecture/index.md を参照。
CREATE TABLE IF NOT EXISTS `${SCHEMA}`.`moments` (
  `moment_id`      CHAR(26)     NOT NULL,               -- ULID
  `user_id`        CHAR(36)     NOT NULL,
  `text`           VARCHAR(180) NOT NULL,
  `image_key`      VARCHAR(255) NOT NULL,               -- orig の key。thumb は _thumb サフィックスで導出
  `fastener`       ENUM('clip','tape') NOT NULL DEFAULT 'clip',
  `fastener_color` ENUM('pink','blue','yellow','green') NULL,
  `status`         ENUM('published','draft') NOT NULL DEFAULT 'published',
  `published_at`   DATETIME(6)  NULL,                   -- draft は NULL。公開時に設定
  `created_at`     DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`     DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`moment_id`),
  KEY `idx_moments_feed` (`user_id`, `status`, `published_at`, `moment_id`)
);
