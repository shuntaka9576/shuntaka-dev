CREATE TABLE IF NOT EXISTS `${SCHEMA}`.`tags` (
  `tag_id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `name` VARCHAR(255) NOT NULL,
  PRIMARY KEY (`tag_id`),
  UNIQUE KEY `uq_tags_name` (`name`)
);
