CREATE TABLE IF NOT EXISTS `${SCHEMA}`.`users` (
  `user_id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `name` VARCHAR(255) NOT NULL,
  `email` VARCHAR(255) NOT NULL,
  `github_installation_id` BIGINT NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`user_id`),
  UNIQUE KEY `uq_users_name` (`name`),
  UNIQUE KEY `uq_users_email` (`email`),
  UNIQUE KEY `uq_users_github_installation_id` (`github_installation_id`)
);
