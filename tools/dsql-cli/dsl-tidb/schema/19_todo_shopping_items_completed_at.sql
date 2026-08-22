-- 購入済み項目をリストに残したまま判別できるよう、完了時刻を保持する。
ALTER TABLE `${SCHEMA}`.`todo_shopping_items`
  ADD COLUMN `completed_at` DATETIME(6) NULL AFTER `quantity`;
