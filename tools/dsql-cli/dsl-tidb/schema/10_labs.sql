-- labs (Zenn books 風ハンズオン教材の「本」)。lab-contents リポジトリの
-- labs/<slug>/config.yaml を GitHub webhook 経由で同期する。設計は
-- docs/source/98_tasks/2026-07-28-labs-feature/index.md を参照。
-- FK なし・アプリ層整合の方針は他テーブルと同じ。
CREATE TABLE IF NOT EXISTS `${SCHEMA}`.`labs` (
  `lab_id`     CHAR(36)     NOT NULL DEFAULT (UUID()),
  `user_id`    CHAR(36)     NOT NULL,
  `slug`       VARCHAR(255) NOT NULL,               -- labs/ 配下のディレクトリ名
  `title`      VARCHAR(500) NOT NULL,               -- config.yaml の title
  `summary`    TEXT         NULL,                   -- config.yaml の summary
  `published`  TINYINT(1)   NOT NULL DEFAULT 0,     -- config.yaml の published
  `created_at` DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`lab_id`),
  UNIQUE KEY `uq_labs_slug` (`slug`),
  KEY `idx_labs_user_id` (`user_id`)
);
