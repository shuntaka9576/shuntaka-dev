-- 直近の献立。空欄は行を持たず、API が「未定」として返す。
CREATE TABLE IF NOT EXISTS `${SCHEMA}`.`todo_meals` (
  `meal_id`    CHAR(26)      NOT NULL, -- ULID
  `user_id`    CHAR(36)      NOT NULL,
  `meal_date`  DATE          NOT NULL,
  `meal_type`  ENUM('breakfast','lunch','dinner') NOT NULL,
  `content`    VARCHAR(1000) NOT NULL,
  `created_at` DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`meal_id`),
  UNIQUE KEY `uq_todo_meal_user_date_type` (`user_id`, `meal_date`, `meal_type`),
  KEY `idx_todo_meal_user_date` (`user_id`, `meal_date`)
);
