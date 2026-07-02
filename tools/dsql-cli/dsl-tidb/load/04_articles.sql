SET time_zone = '+00:00';
-- 注意: LOAD DATA は TiDB の txn-total-size-limit (デフォルト 100MB) に縛られる。
-- v8+ の `SET SESSION tidb_dml_type = 'bulk'` は INSERT/UPDATE/DELETE の SELECT 派生専用で
-- LOAD DATA には効かない (survey/2026-07-01-tidb-load-data-large-file.md)。
-- TiDB に流す TSV は tidb-seeder の --rows-per-part 15000 (≈90MB/ファイル) で分割する。

LOAD DATA LOCAL INFILE '${TSV}'
INTO TABLE `${SCHEMA}`.`articles`
CHARACTER SET utf8mb4
FIELDS TERMINATED BY '\t' ESCAPED BY '\\'
LINES TERMINATED BY '\n'
(`article_id`, `title`, `slug`, `user_id`, `content`, @thumbnail, `description`, `status`,
 @type, @published_at, @created_at, @updated_at)
SET
  `thumbnail`    = NULLIF(@thumbnail, '\\N'),
  `type`         = NULLIF(@type, '\\N'),
  `published_at` = NULLIF(@published_at, '\\N'),
  `created_at`   = NULLIF(@created_at, '\\N'),
  `updated_at`   = NULLIF(@updated_at, '\\N');

SELECT 'articles' AS table_name, @@warning_count AS warnings;
SHOW WARNINGS;
