-- tag_article_counts 集計テーブルの初期投入 SQL（2026-07-05）
-- 目的: ファセット集計（tags なし全体）を前計算し、44 秒超の祖先ロールアップクエリを廃止する。
-- 冪等: DELETE FROM で全行削除してから再計算するため、何度実行しても結果が同じになる。
-- 適用: mysql -h 127.0.0.1 -P 4100 -u root -D blog_test < backfill_tag_article_counts.sql
-- 本番: mysql -h tidb.$TAILNET -P 4000 -u root -D $SCHEMA < backfill_tag_article_counts.sql

-- 既存データを全消し（テーブル全体）してから再投入
DELETE FROM tag_article_counts;

-- published 記事 × leaf タグ × 祖先ロールアップを集計して INSERT する。
-- tag_ancestors CTE: leaf タグの tag_id を起点に parent_tag_id を辿り、
-- 自身を含む全祖先 (anc_tag_id) を展開する。最大3階層なので再帰深さは最大2ステップ。
-- GROUP BY (user_id, type, anc_tag_id) で記事数を COUNT DISTINCT する。
INSERT INTO tag_article_counts (user_id, `type`, tag_id, article_count)
WITH RECURSIVE tag_ancestors AS (
    -- ベース: 各タグは自分自身の祖先でもある
    SELECT tag_id AS leaf_tag_id, tag_id AS anc_tag_id FROM tags
    UNION ALL
    -- 再帰: anc_tag_id の親を辿る（parent_tag_id IS NOT NULL の間だけ展開）
    SELECT ta.leaf_tag_id, t.parent_tag_id AS anc_tag_id
    FROM tag_ancestors ta
    JOIN tags t ON t.tag_id = ta.anc_tag_id
    WHERE t.parent_tag_id IS NOT NULL
)
SELECT
    a.user_id,
    a.`type`,
    ta.anc_tag_id AS tag_id,
    COUNT(DISTINCT ats.article_id) AS article_count
FROM articles a
JOIN articles_tags ats ON ats.article_id = a.article_id
JOIN tag_ancestors ta ON ta.leaf_tag_id = ats.tag_id
WHERE a.status = 'published'
  AND a.`type` IS NOT NULL
GROUP BY a.user_id, a.`type`, ta.anc_tag_id;
