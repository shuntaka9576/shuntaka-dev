-- 出典: apps/blog-api/adapter/src/repository/articles.rs
-- sync_tags(): 記事のタグ関連を DELETE ALL + INSERT の冪等方式で同期
--   1. articles_tags から対象記事の行を全削除
--   2. タグパスを / で分割し、浅い方から INSERT IGNORE INTO tags で存在保証
--        - 最上位:  INSERT IGNORE INTO tags(name)
--        - 2 段目〜: INSERT IGNORE INTO tags(name, parent_tag_id)
--                    SELECT ?, tag_id FROM tags WHERE name = ?    ← 1つ浅いセグメント名
--   3. leaf タグに対してのみ articles_tags を張る
--
-- 実運用ではトランザクション内でループ実行される。playground では
-- 単一タグパス "tech/aws/lambda" を投入する例を並べる。

SET @article_id = '00000000-0000-0000-0000-000000000000';
SET @tag_lvl1   = 'tech';    -- 最上位（parent_tag_id IS NULL）
SET @tag_lvl2   = 'aws';     -- 2 段目
SET @tag_lvl3   = 'lambda';  -- 3 段目（leaf）

START TRANSACTION;

-- (1) 対象記事のタグ関連を消す
DELETE FROM articles_tags WHERE article_id = @article_id;

-- (2) タグ階層を浅い方から存在保証する
INSERT IGNORE INTO tags (name) VALUES (@tag_lvl1);

INSERT IGNORE INTO tags (name, parent_tag_id)
SELECT @tag_lvl2, tag_id FROM tags WHERE name = @tag_lvl1;

INSERT IGNORE INTO tags (name, parent_tag_id)
SELECT @tag_lvl3, tag_id FROM tags WHERE name = @tag_lvl2;

-- (3) leaf タグを articles_tags に張る
INSERT IGNORE INTO articles_tags (article_id, tag_id)
SELECT @article_id, tag_id FROM tags WHERE name = @tag_lvl3;

ROLLBACK;
