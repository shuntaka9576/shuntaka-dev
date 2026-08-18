-- 現在必要な買い物だけを保持する。購入済み・不要になった項目は DELETE する。
CREATE TABLE IF NOT EXISTS `${SCHEMA}`.`todo_shopping_items` (
  `shopping_item_id` CHAR(26)      NOT NULL, -- ULID
  `user_id`          CHAR(36)      NOT NULL,
  `name`             VARCHAR(500)  NOT NULL,
  `normalized_name`  VARCHAR(500)  NOT NULL,
  `quantity`         VARCHAR(255)  NULL,
  `created_at`       DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`       DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`shopping_item_id`),
  UNIQUE KEY `uq_todo_shopping_user_normalized_name` (`user_id`, `normalized_name`),
  KEY `idx_todo_shopping_user_created` (`user_id`, `created_at`)
);
