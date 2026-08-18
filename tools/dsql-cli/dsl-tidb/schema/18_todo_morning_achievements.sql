-- 9時を目安に記録する、日付ごとの朝活実績。
CREATE TABLE IF NOT EXISTS `${SCHEMA}`.`todo_morning_achievements` (
  `achievement_id`   CHAR(26)      NOT NULL, -- ULID
  `user_id`          CHAR(36)      NOT NULL,
  `achievement_date` DATE          NOT NULL,
  `parenting_load`   VARCHAR(10)   NOT NULL, -- none / light / normal / heavy
  `free_minutes`     SMALLINT      NOT NULL, -- 0 / 30 / 60 / 90 / 120 (120は2時間以上)
  `allocation`       VARCHAR(20)   NOT NULL, -- none / idle / exercise / study / exercise_study
  `note`             VARCHAR(2000) NULL,
  `created_at`       DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`       DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`achievement_id`),
  UNIQUE KEY `uq_todo_morning_achievement_user_date` (`user_id`, `achievement_date`)
);
