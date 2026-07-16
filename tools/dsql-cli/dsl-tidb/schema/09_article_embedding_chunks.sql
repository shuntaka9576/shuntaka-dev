-- 2026-07-15 Vector 検索: PLaMO Embedding 1B (2048次元) のarticle chunk。
-- FKは既存方針どおり付けず、article削除時はアプリ層で追従する。
CREATE TABLE IF NOT EXISTS `${SCHEMA}`.`article_embedding_chunks` (
  `chunk_id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `article_id` CHAR(36) NOT NULL,
  `chunk_index` INT UNSIGNED NOT NULL,
  `heading` VARCHAR(1000) NULL,
  `content` LONGTEXT NOT NULL,
  `token_count` INT UNSIGNED NOT NULL,
  `chunking_version` VARCHAR(64) NOT NULL,
  `source_hash` CHAR(64) NOT NULL,
  `embedding` VECTOR(2048) NOT NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`chunk_id`),
  UNIQUE KEY `uq_article_embedding_chunks_article_index` (`article_id`, `chunk_index`)
);

-- Vector indexはTiFlash replicaを必要とする。既存データのbackfillとCOMPACT後に
-- idx_article_embedding_chunks_embeddingを作成するため、初期DDLには含めない。
ALTER TABLE `${SCHEMA}`.`article_embedding_chunks` SET TIFLASH REPLICA 1;
