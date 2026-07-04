CREATE TABLE IF NOT EXISTS `${SCHEMA}`.`tags` (
  `tag_id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `name` VARCHAR(255) NOT NULL,
  PRIMARY KEY (`tag_id`),
  UNIQUE KEY `uq_tags_name` (`name`)
);

-- 2026-07-05 タグ階層（最大3階層）対応
-- 隣接リスト方式。読み取りは WITH RECURSIVE でフルパス（aws/lambda/snapstart）を解決する。
-- 深さ上限（3階層）はアプリ層 parse_tag_path で担保（DB では強制できない）。
-- name はグローバル一意（uq_tags_name 維持）。同名タグを別の親配下に持てない制約になるが、
-- leaf 名だけで tag_id を逆引きできるため webhook 同期・backfill が単純になる。
-- FK は付けない（既存方針: アプリ層で担保）。記事との関連 (articles_tags) は leaf タグのみに張る。
-- TiDB は ADD COLUMN と ADD KEY を1つの ALTER にまとめられないため2文に分ける。
ALTER TABLE `${SCHEMA}`.`tags`
  ADD COLUMN `parent_tag_id` CHAR(36) NULL;
ALTER TABLE `${SCHEMA}`.`tags`
  ADD KEY `idx_tags_parent_tag_id` (`parent_tag_id`);
