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
  `captured_at`    DATETIME(6)  NOT NULL,               -- 撮影時刻 (EXIF 同様 TZ なしの壁時計)。クライアントが補完。表示・ソートに使う
  `published_at`   DATETIME(6)  NULL,                   -- 初回公開時刻の記録。未公開の draft は NULL。draft に戻しても保持
  `created_at`     DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`     DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`moment_id`),
  KEY `idx_moments_feed` (`user_id`, `status`, `captured_at`, `moment_id`)
);
