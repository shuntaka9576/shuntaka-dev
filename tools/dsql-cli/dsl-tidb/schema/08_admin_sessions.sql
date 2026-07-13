-- admin 管理画面 (admin.shuntaka.dev) のセッションストア。Cognito トークン一式を
-- DB に置き、Cookie には seal したセッション ID (sid) のみを入れる (4KB 上限対策)。
-- 期限切れレコードはログイン時に掃除する (単一ユーザー運用のため cron は持たない)。
CREATE TABLE IF NOT EXISTS `${SCHEMA}`.`admin_sessions` (
  `sid`           VARCHAR(64) NOT NULL,
  `user_id`       CHAR(36)    NOT NULL,               -- ログイン時に users.name から解決した users.user_id
  `access_token`  TEXT        NOT NULL,
  `id_token`      TEXT        NOT NULL,
  `refresh_token` TEXT        NOT NULL,
  `expires_at`    DATETIME(6) NOT NULL,
  `created_at`    DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`    DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`sid`)
);
