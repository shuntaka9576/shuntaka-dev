-- 出典: apps/blog-api/adapter/src/repository/articles.rs
-- sync_tag_article_counts(): user 単位で tag_article_counts を DELETE + INSERT で再計算
--   - published 記事だけを対象に
--   - articles_tags を祖先ロールアップ（子→親を tag_ancestors CTE で辿る）
--   - user_id × 祖先タグ ごとに COUNT(DISTINCT article_id) を集計
--
-- `type` カラムは廃止済み概念だが、既存 PK (user_id, type, tag_id) が NOT NULL なので
-- 定数 'all' を入れる。読み取り側は type を横断して SUM する（09_tag_facets.sql 参照）。
--
-- playground はステートメントごとに接続を切ることがあり、その場合は
-- セッション変数が引き継がれない。SET と本体クエリを同一トランザクションで
-- 一括送信するため BEGIN ... ROLLBACK で囲む。

BEGIN;
SET @user_id = '00000000-0000-0000-0000-000000000000';

DELETE FROM tag_article_counts WHERE user_id = @user_id;

INSERT INTO tag_article_counts (user_id, `type`, tag_id, article_count)
WITH RECURSIVE tag_ancestors AS (
    SELECT tag_id AS leaf_tag_id, tag_id AS anc_tag_id FROM tags
    UNION ALL
    SELECT ta.leaf_tag_id, t.parent_tag_id AS anc_tag_id
      FROM tag_ancestors ta
      JOIN tags t ON t.tag_id = ta.anc_tag_id
     WHERE t.parent_tag_id IS NOT NULL
)
SELECT a.user_id, 'all', ta.anc_tag_id, COUNT(DISTINCT ats.article_id)
  FROM articles a
  JOIN articles_tags ats ON ats.article_id = a.article_id
  JOIN tag_ancestors ta  ON ta.leaf_tag_id  = ats.tag_id
 WHERE a.user_id = @user_id AND a.status = 'published'
 GROUP BY a.user_id, ta.anc_tag_id;

ROLLBACK;
