-- 出典: apps/blog-api/adapter/src/repository/users_articles.rs
-- UsersArticlesRepositoryImpl::search_published_by_user_name
-- 公開側のベクトル検索。TiFlash 上の article_embedding_chunks に対し ANN 候補を取り、
-- 外側で status='published' / user_name / タグフィルタで post-filter する。
-- user/status/tag を HNSW の内側に置くと TiFlash 全走査になるため、必ずまず chunk を絞る。

-- ────────────────────────────────────
-- 共通パラメータ
--   embedding は VECTOR(2048)。JSON 配列文字列で渡す（sqlx 実装と同じ）。
--   playground では全 0 のダミーを 2048 個並べたい場合は
--     SET @v = CONCAT('[', REPEAT('0,', 2047), '0]');
--   のように組み立てるとよい。
--
--   LIMIT / OFFSET は MySQL / TiDB 仕様で @var を受け付けないため
--   （リテラル整数 or prepared placeholder のみ）、各クエリの
--   `LIMIT 50` (candidate) / `LIMIT 10 OFFSET 0` (page) を直接書き換える。
-- ────────────────────────────────────

SET @user_name = 'shuntaka';
SET @vector    = CONCAT('[', REPEAT('0,', 2047), '0]');


-- ────────────────────────────────────
-- (A) フィルタなし
-- ────────────────────────────────────

WITH nearest_chunks AS (
    SELECT /*+ READ_FROM_STORAGE(TIFLASH[c]) */
           c.article_id,
           VEC_COSINE_DISTANCE(c.embedding, @vector) AS distance
      FROM article_embedding_chunks AS c
     ORDER BY VEC_COSINE_DISTANCE(c.embedding, @vector)
     LIMIT 50
),
ranked_articles AS (
    SELECT a.article_id, a.title, a.slug, a.user_id, a.thumbnail, a.description,
           a.status, a.published_at, a.created_at, a.updated_at, nc.distance,
           ROW_NUMBER() OVER (
               PARTITION BY a.article_id ORDER BY nc.distance, a.article_id
           ) AS chunk_rank
      FROM nearest_chunks AS nc
      JOIN articles AS a ON a.article_id = nc.article_id
      JOIN users    AS u ON u.user_id    = a.user_id
     WHERE a.status = 'published'
       AND u.name   = @user_name
)
SELECT article_id, title, slug, user_id, thumbnail, description, status,
       published_at, created_at, updated_at, distance,
       COUNT(*) OVER() AS total_count
  FROM ranked_articles
 WHERE chunk_rank = 1
 ORDER BY distance, article_id
 LIMIT 10 OFFSET 0;


-- ────────────────────────────────────
-- (B) タグ 2 件 AND フィルタ
--   ranked_articles CTE の WHERE に EXISTS を積む
-- ────────────────────────────────────

SET @tag_id_a = '00000000-0000-0000-0000-000000000001';
SET @tag_id_b = '00000000-0000-0000-0000-000000000002';

WITH RECURSIVE tag_descendants AS (
    SELECT tag_id, tag_id AS root_tag_id FROM tags WHERE tag_id IN (@tag_id_a, @tag_id_b)
    UNION ALL
    SELECT t.tag_id, td.root_tag_id FROM tags t
    JOIN tag_descendants td ON t.parent_tag_id = td.tag_id
),
nearest_chunks AS (
    SELECT /*+ READ_FROM_STORAGE(TIFLASH[c]) */
           c.article_id,
           VEC_COSINE_DISTANCE(c.embedding, @vector) AS distance
      FROM article_embedding_chunks AS c
     ORDER BY VEC_COSINE_DISTANCE(c.embedding, @vector)
     LIMIT 50
),
ranked_articles AS (
    SELECT a.article_id, a.title, a.slug, a.user_id, a.thumbnail, a.description,
           a.status, a.published_at, a.created_at, a.updated_at, nc.distance,
           ROW_NUMBER() OVER (
               PARTITION BY a.article_id ORDER BY nc.distance, a.article_id
           ) AS chunk_rank
      FROM nearest_chunks AS nc
      JOIN articles AS a ON a.article_id = nc.article_id
      JOIN users    AS u ON u.user_id    = a.user_id
     WHERE a.status = 'published'
       AND u.name   = @user_name
       AND EXISTS (SELECT 1 FROM articles_tags at0
                     JOIN tag_descendants td ON at0.tag_id = td.tag_id AND td.root_tag_id = @tag_id_a
                    WHERE at0.article_id = a.article_id)
       AND EXISTS (SELECT 1 FROM articles_tags at1
                     JOIN tag_descendants td ON at1.tag_id = td.tag_id AND td.root_tag_id = @tag_id_b
                    WHERE at1.article_id = a.article_id)
)
SELECT article_id, title, slug, user_id, thumbnail, description, status,
       published_at, created_at, updated_at, distance,
       COUNT(*) OVER() AS total_count
  FROM ranked_articles
 WHERE chunk_rank = 1
 ORDER BY distance, article_id
 LIMIT 10 OFFSET 0;


-- ────────────────────────────────────
-- (C) タグ 2 件 OR フィルタ
-- ────────────────────────────────────

WITH RECURSIVE tag_descendants AS (
    SELECT tag_id FROM tags WHERE tag_id IN (@tag_id_a, @tag_id_b)
    UNION ALL
    SELECT t.tag_id FROM tags t
    JOIN tag_descendants td ON t.parent_tag_id = td.tag_id
),
nearest_chunks AS (
    SELECT /*+ READ_FROM_STORAGE(TIFLASH[c]) */
           c.article_id,
           VEC_COSINE_DISTANCE(c.embedding, @vector) AS distance
      FROM article_embedding_chunks AS c
     ORDER BY VEC_COSINE_DISTANCE(c.embedding, @vector)
     LIMIT 50
),
ranked_articles AS (
    SELECT a.article_id, a.title, a.slug, a.user_id, a.thumbnail, a.description,
           a.status, a.published_at, a.created_at, a.updated_at, nc.distance,
           ROW_NUMBER() OVER (
               PARTITION BY a.article_id ORDER BY nc.distance, a.article_id
           ) AS chunk_rank
      FROM nearest_chunks AS nc
      JOIN articles AS a ON a.article_id = nc.article_id
      JOIN users    AS u ON u.user_id    = a.user_id
     WHERE a.status = 'published'
       AND u.name   = @user_name
       AND EXISTS (SELECT 1 FROM articles_tags ats
                     JOIN tag_descendants td ON ats.tag_id = td.tag_id
                    WHERE ats.article_id = a.article_id)
)
SELECT article_id, title, slug, user_id, thumbnail, description, status,
       published_at, created_at, updated_at, distance,
       COUNT(*) OVER() AS total_count
  FROM ranked_articles
 WHERE chunk_rank = 1
 ORDER BY distance, article_id
 LIMIT 10 OFFSET 0;
