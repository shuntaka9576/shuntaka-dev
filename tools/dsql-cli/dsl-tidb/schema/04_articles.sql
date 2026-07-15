CREATE TABLE IF NOT EXISTS `${SCHEMA}`.`articles` (
  `article_id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `title` VARCHAR(500) NOT NULL,
  `slug` VARCHAR(255) NOT NULL,
  `user_id` CHAR(36) NOT NULL,
  `content` LONGTEXT NOT NULL,
  `thumbnail` TEXT NULL,
  `description` TEXT NOT NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'draft',
  `type` VARCHAR(50) NULL,
  `published_at` DATETIME(6) NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`article_id`),
  UNIQUE KEY `uq_articles_slug` (`slug`),
  KEY `idx_articles_user_id` (`user_id`),
  KEY `idx_articles_status_published_at` (`status`, `published_at`)
);
-- NOTE: 元の DSQL では status に CHECK 制約 (draft/review/scheduled/published/archived) を
-- かけていた。TiDB は `tidb_enable_check_constraint` がデフォルト OFF で CHECK を書くと
-- "switch of check constraint is off" 警告が出る。当面はアプリ層 (blog-api) で値を
-- バリデーションする方針とし、ここでは CHECK を付けない。
-- TiDB クラスタ単位で有効化する場合は管理者が
--   SET GLOBAL tidb_enable_check_constraint = ON;
-- を実行したうえで CHECK を別途 ALTER TABLE で追加する。

-- 2026-06-30
ALTER TABLE `${SCHEMA}`.`articles`
  ADD INDEX `idx_articles_user_status_type_published_at` (`user_id`, `status`, `type`, `published_at`);
ALTER TABLE `${SCHEMA}`.`articles` DROP INDEX `idx_articles_user_id`;
ALTER TABLE `${SCHEMA}`.`articles` DROP INDEX `idx_articles_status_published_at`;

-- 2026-06-30 Phase 4 (JOIN 分離 + ORDER BY 安定化 + Limit pushdown)
-- 新インデックスは旧 idx_articles_user_status_type_published_at の完全な superset。
-- ORDER BY published_at DESC, article_id DESC に対し keep order:true, desc が選ばれ、
-- Limit pushdown が効くようになる (dev 計測: TableRowIDScan actRows 37 -> 10, 合計時間 2.75ms -> 1.75ms)。
ALTER TABLE `${SCHEMA}`.`articles`
  ADD INDEX `idx_articles_user_status_type_published_at_id` (`user_id`, `status`, `type`, `published_at`, `article_id`);
ALTER TABLE `${SCHEMA}`.`articles` DROP INDEX `idx_articles_user_status_type_published_at`;

-- 2026-07-02 content_html 事前生成
-- 記事詳細 API が毎リクエストで Markdown→HTML 変換（OGP リンクカード等の同期 HTTP フェッチ込み）
-- していたのをやめ、GitHub webhook の upsert 時（content 変更時・新規作成時）に変換して保存する。
-- 既存レコードは NULL のまま（GET は NULL 時のみオンザフライ変換にフォールバック）。
-- 埋め戻しは tools/content-html-backfill で content_html カラムだけを UPDATE する
-- （updated_at には ON UPDATE が無いので値が保持される。webhook 再実行での埋め戻しは
--   upsert が updated_at を更新してしまうため使わない）。
ALTER TABLE `${SCHEMA}`.`articles`
  ADD COLUMN `content_html` LONGTEXT NULL AFTER `content`;

-- 2026-07-15 Vector 検索: PLaMo Embedding 1B (実測 2048 次元) + HNSW on TiFlash
ALTER TABLE `${SCHEMA}`.`articles`
  ADD COLUMN `embedding` VECTOR(2048) NULL AFTER `content_html`;

-- Vector index は TiFlash replica を必要とするため、index 作成前に replica を設定する。
ALTER TABLE `${SCHEMA}`.`articles` SET TIFLASH REPLICA 1;

-- HNSW index は embedding の backfill と TiFlash COMPACT の完了後に作成する。
-- 全行 NULL の既存 DMFile に先に index を作ると TiFlash v8.5.7 が index build 中に
-- Floating point exception でクラッシュするため、初期構築 DDL には含めない。
