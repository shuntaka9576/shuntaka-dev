SET time_zone = '+00:00';

LOAD DATA LOCAL INFILE '${TSV}'
INTO TABLE `${SCHEMA}`.`users`
CHARACTER SET utf8mb4
FIELDS TERMINATED BY '\t' ESCAPED BY '\\'
LINES TERMINATED BY '\n'
(`user_id`, `name`, `email`, @github_installation_id, @created_at, @updated_at)
SET
  `github_installation_id` = NULLIF(@github_installation_id, '\\N'),
  `created_at`             = NULLIF(@created_at, '\\N'),
  `updated_at`             = NULLIF(@updated_at, '\\N');

SELECT 'users' AS table_name, @@warning_count AS warnings;
SHOW WARNINGS;
