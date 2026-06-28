SET time_zone = '+00:00';

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
