CREATE TABLE IF NOT EXISTS `${SCHEMA}`.`tag_article_counts` (
  `user_id` CHAR(36) NOT NULL,
  `type` VARCHAR(20) NOT NULL,
  `tag_id` CHAR(36) NOT NULL,
  `article_count` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`user_id`, `type`, `tag_id`)
);
