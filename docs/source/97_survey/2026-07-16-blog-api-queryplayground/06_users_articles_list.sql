-- 出典: apps/blog-api/adapter/src/repository/users_articles.rs
-- UsersArticlesRepositoryImpl::find_published_by_user_name
-- 公開側の記事一覧。実装ではタグフィルタの有無 / AND | OR モードで
-- CTE + EXISTS を組み立てているので、代表 4 パターンを並べる。
-- 一覧クエリと COUNT クエリは並列に投げる（Tailscale RTT を隠すため）。

-- ────────────────────────────────────
-- 共通パラメータ
--   playground はステートメントごとに接続を切ることがあり、その場合は
--   セッション変数が引き継がれない。同一トランザクション内で SET と本体クエリを
--   一括送信するため、各セクションを BEGIN ... COMMIT で囲む。
--
--   LIMIT / OFFSET は MySQL / TiDB 仕様で @var を受け付けない
--   （リテラル整数 or prepared placeholder のみ）ため、各クエリの LIMIT 20 OFFSET 0
--   の数値を直接書き換える運用にしている。
-- ────────────────────────────────────


-- ────────────────────────────────────
-- (A) フィルタなし
-- ────────────────────────────────────

BEGIN;
SET @user_name = 'shuntaka';

SELECT /*+ USE_INDEX(a, idx_articles_user_status_type_published_at_id) */
       a.article_id, a.title, a.slug, a.user_id, a.thumbnail, a.description,
       a.status, a.published_at, a.created_at, a.updated_at
  FROM articles a
 WHERE a.user_id = (SELECT user_id FROM users WHERE name = @user_name)
   AND a.status = 'published'
 ORDER BY a.published_at DESC, a.article_id DESC
 LIMIT 20 OFFSET 0;

-- COUNT
SELECT COUNT(*)
  FROM articles a
 WHERE a.user_id = (SELECT user_id FROM users WHERE name = @user_name)
   AND a.status = 'published';
COMMIT;


-- ────────────────────────────────────
-- (B) タグ 1 件フィルタ（AND / OR とも同形）
--     leaf 名で tag_id を解決してから流す（前段クエリは 09_tag_facets.sql / 実装参照）
-- ────────────────────────────────────

BEGIN;
SET @user_name = 'shuntaka';
SET @tag_id_1  = '00000000-0000-0000-0000-000000000001';

WITH RECURSIVE tag_descendants AS (
    SELECT tag_id, tag_id AS root_tag_id FROM tags WHERE tag_id IN (@tag_id_1)
    UNION ALL
    SELECT t.tag_id, td.root_tag_id FROM tags t
    JOIN tag_descendants td ON t.parent_tag_id = td.tag_id
)
SELECT /*+ USE_INDEX(a, idx_articles_user_status_type_published_at_id) */
       a.article_id, a.title, a.slug, a.user_id, a.thumbnail, a.description,
       a.status, a.published_at, a.created_at, a.updated_at
  FROM articles a
 WHERE a.user_id = (SELECT user_id FROM users WHERE name = @user_name)
   AND a.status = 'published'
   AND EXISTS (SELECT 1 FROM articles_tags at0
                 JOIN tag_descendants td ON at0.tag_id = td.tag_id AND td.root_tag_id = @tag_id_1
                WHERE at0.article_id = a.article_id)
 ORDER BY a.published_at DESC, a.article_id DESC
 LIMIT 20 OFFSET 0;
COMMIT;


-- ────────────────────────────────────
-- (C) タグ 2 件 AND
--   EXISTS を tag_id ごとに 1 個ずつ生やして AND 連結
-- ────────────────────────────────────

BEGIN;
SET @user_name = 'shuntaka';
SET @tag_id_a  = '00000000-0000-0000-0000-000000000001';
SET @tag_id_b  = '00000000-0000-0000-0000-000000000002';

WITH RECURSIVE tag_descendants AS (
    SELECT tag_id, tag_id AS root_tag_id FROM tags WHERE tag_id IN (@tag_id_a, @tag_id_b)
    UNION ALL
    SELECT t.tag_id, td.root_tag_id FROM tags t
    JOIN tag_descendants td ON t.parent_tag_id = td.tag_id
)
SELECT /*+ USE_INDEX(a, idx_articles_user_status_type_published_at_id) */
       a.article_id, a.title, a.slug, a.user_id, a.thumbnail, a.description,
       a.status, a.published_at, a.created_at, a.updated_at
  FROM articles a
 WHERE a.user_id = (SELECT user_id FROM users WHERE name = @user_name)
   AND a.status = 'published'
   AND EXISTS (SELECT 1 FROM articles_tags at0
                 JOIN tag_descendants td ON at0.tag_id = td.tag_id AND td.root_tag_id = @tag_id_a
                WHERE at0.article_id = a.article_id)
   AND EXISTS (SELECT 1 FROM articles_tags at1
                 JOIN tag_descendants td ON at1.tag_id = td.tag_id AND td.root_tag_id = @tag_id_b
                WHERE at1.article_id = a.article_id)
 ORDER BY a.published_at DESC, a.article_id DESC
 LIMIT 20 OFFSET 0;
COMMIT;


-- ────────────────────────────────────
-- (D) タグ 2 件 OR
--   全 tag_id の子孫を 1 つの CTE にまとめて EXISTS 1 個で判定
-- ────────────────────────────────────

BEGIN;
SET @user_name = 'shuntaka';
SET @tag_id_a  = '00000000-0000-0000-0000-000000000001';
SET @tag_id_b  = '00000000-0000-0000-0000-000000000002';

WITH RECURSIVE tag_descendants AS (
    SELECT tag_id FROM tags WHERE tag_id IN (@tag_id_a, @tag_id_b)
    UNION ALL
    SELECT t.tag_id FROM tags t
    JOIN tag_descendants td ON t.parent_tag_id = td.tag_id
)
SELECT /*+ USE_INDEX(a, idx_articles_user_status_type_published_at_id) */
       a.article_id, a.title, a.slug, a.user_id, a.thumbnail, a.description,
       a.status, a.published_at, a.created_at, a.updated_at
  FROM articles a
 WHERE a.user_id = (SELECT user_id FROM users WHERE name = @user_name)
   AND a.status = 'published'
   AND EXISTS (SELECT 1 FROM articles_tags ats
                 JOIN tag_descendants td ON ats.tag_id = td.tag_id
                WHERE ats.article_id = a.article_id)
 ORDER BY a.published_at DESC, a.article_id DESC
 LIMIT 20 OFFSET 0;
COMMIT;


-- ────────────────────────────────────
-- (E) ページ内記事のタグをまとめて取得（2 クエリ方式の 2 本目）
--   fetch_article_tags(): 1 本目で得た article_id のリストに対し
--   フルパスタグをまとめて返す。
--   IN () のプレースホルダは 3 件並べた例を書いておく。
-- ────────────────────────────────────

BEGIN;
SET @aid_1 = '00000000-0000-0000-0000-0000000000a1';
SET @aid_2 = '00000000-0000-0000-0000-0000000000a2';
SET @aid_3 = '00000000-0000-0000-0000-0000000000a3';

WITH RECURSIVE tag_paths AS (
    SELECT tag_id, name AS path FROM tags WHERE parent_tag_id IS NULL
    UNION ALL
    SELECT t.tag_id, CONCAT(tp.path, '/', t.name) FROM tags t
    JOIN tag_paths tp ON t.parent_tag_id = tp.tag_id
)
SELECT at2.article_id,
       GROUP_CONCAT(tp.path ORDER BY tp.path SEPARATOR ',') AS tag_names
  FROM articles_tags at2
  JOIN tag_paths tp ON at2.tag_id = tp.tag_id
 WHERE at2.article_id IN (@aid_1, @aid_2, @aid_3)
 GROUP BY at2.article_id;
COMMIT;


-- ────────────────────────────────────
-- (F) タグパス → tag_id 解決（resolve_tag_ids_for_paths）
--   一覧 / ファセット / 検索いずれもフィルタ指定時に必ず先行する。
--   leaf 名（"tech/aws/lambda" なら "lambda"）だけで解決する（tags.name はグローバル一意）。
-- ────────────────────────────────────

BEGIN;
SET @leaf_1 = 'lambda';
SET @leaf_2 = 'rust';

SELECT tag_id, name
  FROM tags
 WHERE name IN (@leaf_1, @leaf_2);
COMMIT;
