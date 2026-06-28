SET time_zone = '+00:00';

LOAD DATA LOCAL INFILE '${TSV}'
INTO TABLE `${SCHEMA}`.`articles_tags`
CHARACTER SET utf8mb4
FIELDS TERMINATED BY '\t' ESCAPED BY '\\'
LINES TERMINATED BY '\n'
(`article_id`, `tag_id`);

SELECT 'articles_tags' AS table_name, @@warning_count AS warnings;
SHOW WARNINGS;
