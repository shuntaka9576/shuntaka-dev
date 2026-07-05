SET time_zone = '+00:00';

LOAD DATA LOCAL INFILE '${TSV}'
INTO TABLE `${SCHEMA}`.`tags`
CHARACTER SET utf8mb4
FIELDS TERMINATED BY '\t' ESCAPED BY '\\'
LINES TERMINATED BY '\n'
(`tag_id`, `name`, `parent_tag_id`);

SELECT 'tags' AS table_name, @@warning_count AS warnings;
SHOW WARNINGS;
