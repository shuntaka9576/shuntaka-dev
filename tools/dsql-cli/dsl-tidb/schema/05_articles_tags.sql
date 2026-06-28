CREATE TABLE IF NOT EXISTS `${SCHEMA}`.`articles_tags` (
  `article_id` CHAR(36) NOT NULL,
  `tag_id` CHAR(36) NOT NULL,
  PRIMARY KEY (`article_id`, `tag_id`),
  KEY `idx_articles_tags_tag_id` (`tag_id`)
);
