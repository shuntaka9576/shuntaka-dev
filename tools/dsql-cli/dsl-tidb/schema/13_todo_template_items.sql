-- 毎日のチェックリスト生成元。本文をコードへ埋め込まないための非公開データ。
CREATE TABLE IF NOT EXISTS `${SCHEMA}`.`todo_template_items` (
  `template_item_id`        CHAR(26)      NOT NULL, -- ULID
  `user_id`                 CHAR(36)      NOT NULL,
  `period`                  ENUM('morning','bedtime') NOT NULL,
  `parent_template_item_id` CHAR(26)      NULL,
  `title`                   VARCHAR(1000) NOT NULL,
  `position`                INT           NOT NULL,
  `created_at`              DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`              DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`template_item_id`),
  KEY `idx_todo_template_user_period_position` (`user_id`, `period`, `position`)
);
