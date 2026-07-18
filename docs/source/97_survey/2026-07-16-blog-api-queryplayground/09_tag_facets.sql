-- 出典: apps/blog-api/adapter/src/repository/users_articles.rs
-- UsersArticlesRepositoryImpl::find_tag_facets
-- タグファセット集計。フィルタ有無で 2 系統に分岐する。
--
-- playground はステートメントごとに接続を切ることがあり、その場合は
-- セッション変数が引き継がれない。同一トランザクション内で SET と本体クエリを
-- 一括送信するため、各セクションを BEGIN ... COMMIT で囲む。


-- ────────────────────────────────────
-- (A) フィルタなし: パネル初期表示 / SSR 埋め込み用
--   前計算テーブル tag_article_counts を読むだけ。O(タグ数) で完了する。
--   `type` 列は廃止済み概念（新規書き込みは定数 'all'）だが、旧 per-type 行が
--   残っている間も合算できるよう SUM で読む。
-- ────────────────────────────────────

BEGIN;
SET @user_name = 'shuntaka';

WITH RECURSIVE tag_paths AS (
    SELECT tag_id, name AS path FROM tags WHERE parent_tag_id IS NULL
    UNION ALL
    SELECT t.tag_id, CONCAT(tp.path, '/', t.name) FROM tags t
    JOIN tag_paths tp ON t.parent_tag_id = tp.tag_id
)
SELECT tp.path, CAST(SUM(tac.article_count) AS SIGNED) AS cnt
  FROM tag_article_counts tac
  JOIN tag_paths tp ON tp.tag_id = tac.tag_id
 WHERE tac.user_id = (SELECT user_id FROM users WHERE name = @user_name)
 GROUP BY tac.tag_id, tp.path
HAVING cnt > 0
 ORDER BY cnt DESC, tp.path ASC;
COMMIT;


-- ────────────────────────────────────
-- (B) タグ 1 件フィルタあり: 選択後の再集計
--   ・MAX_EXECUTION_TIME(8000) で 8 秒 timeout（実装ではエラー扱い）
--   ・anc_tag_id で集計してから tag_paths と JOIN する
--     （集計前に JOIN してパス文字列で GROUP BY すると 5 倍以上遅い / 詳細はコード内コメント）
-- ────────────────────────────────────

BEGIN;
SET @user_name = 'shuntaka';
SET @tag_id_1  = '00000000-0000-0000-0000-000000000001';

WITH RECURSIVE
tag_paths AS (
    SELECT tag_id, name AS path FROM tags WHERE parent_tag_id IS NULL
    UNION ALL
    SELECT t.tag_id, CONCAT(tp.path, '/', t.name) FROM tags t
    JOIN tag_paths tp ON t.parent_tag_id = tp.tag_id
),
tag_ancestors AS (
    SELECT tag_id AS leaf_tag_id, tag_id AS anc_tag_id FROM tags
    UNION ALL
    SELECT ta.leaf_tag_id, t.parent_tag_id AS anc_tag_id FROM tag_ancestors ta
    JOIN tags t ON t.tag_id = ta.anc_tag_id WHERE t.parent_tag_id IS NOT NULL
),
tag_descendants AS (
    SELECT tag_id, tag_id AS root_tag_id FROM tags WHERE tag_id IN (@tag_id_1)
    UNION ALL
    SELECT t.tag_id, td.root_tag_id FROM tags t
    JOIN tag_descendants td ON t.parent_tag_id = td.tag_id
)
SELECT /*+ MAX_EXECUTION_TIME(8000) */ tp.path, agg.cnt
FROM (
    SELECT ta.anc_tag_id, COUNT(DISTINCT ats.article_id) AS cnt
    FROM articles a
    JOIN articles_tags ats ON ats.article_id = a.article_id
    JOIN tag_ancestors ta  ON ta.leaf_tag_id = ats.tag_id
    WHERE a.user_id = (SELECT user_id FROM users WHERE name = @user_name)
      AND a.status = 'published'
      AND EXISTS (SELECT 1 FROM articles_tags ft0
                    JOIN tag_descendants td ON ft0.tag_id = td.tag_id AND td.root_tag_id = @tag_id_1
                   WHERE ft0.article_id = a.article_id)
    GROUP BY ta.anc_tag_id
    HAVING cnt > 0
) agg
JOIN tag_paths tp ON tp.tag_id = agg.anc_tag_id
ORDER BY agg.cnt DESC, tp.path ASC;
COMMIT;


-- ────────────────────────────────────
-- (C) タグ 2 件 AND
-- ────────────────────────────────────

BEGIN;
SET @user_name = 'shuntaka';
SET @tag_id_a  = '00000000-0000-0000-0000-000000000001';
SET @tag_id_b  = '00000000-0000-0000-0000-000000000002';

WITH RECURSIVE
tag_paths AS (
    SELECT tag_id, name AS path FROM tags WHERE parent_tag_id IS NULL
    UNION ALL
    SELECT t.tag_id, CONCAT(tp.path, '/', t.name) FROM tags t
    JOIN tag_paths tp ON t.parent_tag_id = tp.tag_id
),
tag_ancestors AS (
    SELECT tag_id AS leaf_tag_id, tag_id AS anc_tag_id FROM tags
    UNION ALL
    SELECT ta.leaf_tag_id, t.parent_tag_id AS anc_tag_id FROM tag_ancestors ta
    JOIN tags t ON t.tag_id = ta.anc_tag_id WHERE t.parent_tag_id IS NOT NULL
),
tag_descendants AS (
    SELECT tag_id, tag_id AS root_tag_id FROM tags WHERE tag_id IN (@tag_id_a, @tag_id_b)
    UNION ALL
    SELECT t.tag_id, td.root_tag_id FROM tags t
    JOIN tag_descendants td ON t.parent_tag_id = td.tag_id
)
SELECT /*+ MAX_EXECUTION_TIME(8000) */ tp.path, agg.cnt
FROM (
    SELECT ta.anc_tag_id, COUNT(DISTINCT ats.article_id) AS cnt
    FROM articles a
    JOIN articles_tags ats ON ats.article_id = a.article_id
    JOIN tag_ancestors ta  ON ta.leaf_tag_id = ats.tag_id
    WHERE a.user_id = (SELECT user_id FROM users WHERE name = @user_name)
      AND a.status = 'published'
      AND EXISTS (SELECT 1 FROM articles_tags ft0
                    JOIN tag_descendants td ON ft0.tag_id = td.tag_id AND td.root_tag_id = @tag_id_a
                   WHERE ft0.article_id = a.article_id)
      AND EXISTS (SELECT 1 FROM articles_tags ft1
                    JOIN tag_descendants td ON ft1.tag_id = td.tag_id AND td.root_tag_id = @tag_id_b
                   WHERE ft1.article_id = a.article_id)
    GROUP BY ta.anc_tag_id
    HAVING cnt > 0
) agg
JOIN tag_paths tp ON tp.tag_id = agg.anc_tag_id
ORDER BY agg.cnt DESC, tp.path ASC;
COMMIT;


-- ────────────────────────────────────
-- (D) タグ 2 件 OR
-- ────────────────────────────────────

BEGIN;
SET @user_name = 'shuntaka';
SET @tag_id_a  = '00000000-0000-0000-0000-000000000001';
SET @tag_id_b  = '00000000-0000-0000-0000-000000000002';

WITH RECURSIVE
tag_paths AS (
    SELECT tag_id, name AS path FROM tags WHERE parent_tag_id IS NULL
    UNION ALL
    SELECT t.tag_id, CONCAT(tp.path, '/', t.name) FROM tags t
    JOIN tag_paths tp ON t.parent_tag_id = tp.tag_id
),
tag_ancestors AS (
    SELECT tag_id AS leaf_tag_id, tag_id AS anc_tag_id FROM tags
    UNION ALL
    SELECT ta.leaf_tag_id, t.parent_tag_id AS anc_tag_id FROM tag_ancestors ta
    JOIN tags t ON t.tag_id = ta.anc_tag_id WHERE t.parent_tag_id IS NOT NULL
),
tag_descendants AS (
    SELECT tag_id FROM tags WHERE tag_id IN (@tag_id_a, @tag_id_b)
    UNION ALL
    SELECT t.tag_id FROM tags t
    JOIN tag_descendants td ON t.parent_tag_id = td.tag_id
)
SELECT /*+ MAX_EXECUTION_TIME(8000) */ tp.path, agg.cnt
FROM (
    SELECT ta.anc_tag_id, COUNT(DISTINCT ats.article_id) AS cnt
    FROM articles a
    JOIN articles_tags ats ON ats.article_id = a.article_id
    JOIN tag_ancestors ta  ON ta.leaf_tag_id = ats.tag_id
    WHERE a.user_id = (SELECT user_id FROM users WHERE name = @user_name)
      AND a.status = 'published'
      AND EXISTS (SELECT 1 FROM articles_tags fts
                    JOIN tag_descendants td ON fts.tag_id = td.tag_id
                   WHERE fts.article_id = a.article_id)
    GROUP BY ta.anc_tag_id
    HAVING cnt > 0
) agg
JOIN tag_paths tp ON tp.tag_id = agg.anc_tag_id
ORDER BY agg.cnt DESC, tp.path ASC;
COMMIT;
