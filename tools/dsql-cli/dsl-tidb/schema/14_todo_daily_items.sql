-- テンプレートを日ごとにスナップショットしたチェック項目。
CREATE TABLE IF NOT EXISTS `${SCHEMA}`.`todo_daily_items` (
  `daily_item_id`        CHAR(26)      NOT NULL, -- user/date/template から導出する決定的 ID
  `user_id`              CHAR(36)      NOT NULL,
  `todo_date`            DATE          NOT NULL,
  `source_template_id`   CHAR(26)      NOT NULL,
  `parent_daily_item_id` CHAR(26)      NULL,
  `period`               ENUM('morning','bedtime') NOT NULL,
  `title`                VARCHAR(1000) NOT NULL,
  `position`             INT           NOT NULL,
  `completed_at`         DATETIME(6)   NULL,
  `created_at`           DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`           DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`daily_item_id`),
  UNIQUE KEY `uq_todo_daily_source` (`user_id`, `todo_date`, `source_template_id`),
  KEY `idx_todo_daily_user_date_period_position` (`user_id`, `todo_date`, `period`, `position`)
);
