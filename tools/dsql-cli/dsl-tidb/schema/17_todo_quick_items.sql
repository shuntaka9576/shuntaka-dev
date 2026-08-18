-- Markdown由来の日次チェックリストとは独立した、日をまたいで持ち越す簡易TODO。
CREATE TABLE IF NOT EXISTS `${SCHEMA}`.`todo_quick_items` (
  `quick_item_id` CHAR(26)       NOT NULL, -- ULID
  `user_id`       CHAR(36)       NOT NULL,
  `category`      VARCHAR(20)    NOT NULL, -- task / blog_idea
  `title`         VARCHAR(1000)  NOT NULL,
  `completed_at`  DATETIME(6)    NULL,
  `created_at`    DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`    DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`quick_item_id`),
  KEY `idx_todo_quick_user_category_created` (`user_id`, `category`, `created_at`)
);
