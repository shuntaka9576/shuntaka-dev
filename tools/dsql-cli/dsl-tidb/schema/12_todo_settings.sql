-- web-todo のユーザー別設定。チェックリスト本文は公開リポジトリへ置かず、
-- 認証済みの /todo/settings から todo_template_items へ登録する。
CREATE TABLE IF NOT EXISTS `${SCHEMA}`.`todo_settings` (
  `user_id`         CHAR(36)    NOT NULL,
  `timezone`        VARCHAR(64) NOT NULL DEFAULT 'Asia/Tokyo',
  `generation_time` CHAR(5)     NOT NULL DEFAULT '05:00', -- ユーザーのローカル時刻 (HH:mm)
  `source_markdown` LONGTEXT    NOT NULL, -- 規約を含む入力原文。公開コードには置かない
  `created_at`      DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`      DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`user_id`)
);
