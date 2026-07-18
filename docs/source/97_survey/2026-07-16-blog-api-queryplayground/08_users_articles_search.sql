-- 出典: apps/blog-api/adapter/src/repository/users_articles.rs
-- UsersArticlesRepositoryImpl::search_published_by_user_name
--
-- 公開側のベクトル検索（確定版: 全モードページネーションあり）。モードで方式が分かれる。
--   * 検索のみ (A):    HNSW ANN + 固定候補窓 1000 チャンク（offset に依存させない）
--   * 検索 + タグ (B/C): タグを距離計算前に pre-filter し、残りの全チャンクに exact 計算
-- どちらも LIMIT ? OFFSET ? でページを SQL 内で決定的に切り出す
-- （過剰取得してアプリ層 / フロントで絞ることはしない）。
--
-- 旧方式（11_ann_candidate_window_problem.sql 参照）の課題と解消:
--   * total_count が候補窓（offset に比例して拡大）内でしか数えられずページ数が増殖
--       → (A) 窓を定数化。どのページも同一の候補集合を見るため total_count が安定
--       → (B/C) 窓を廃止し exact 集計。total_count は真値でファセット件数と一致
--   * HNSW の近似で窓サイズをまたぐ一貫性がなくページ境界で重複・抜け
--       → (A) 窓サイズが固定なので「サイズをまたぐ」こと自体が消滅。
--         固定 (ベクトル, K, インデックス) への HNSW 探索は再現的
--       → (B/C) exact 計算 + article_id タイブレークで全順序が決定的
--   * タグの post-filter で件数・完全性が保証できずファセット件数と矛盾
--       → (B/C) pre-filter 化で解消
--   * ページ送りごとの embedding 再推論（コスト + ベクトル揺らぎ）
--       → API 側の CachedEmbeddingClient でクエリ文字列 → ベクトルをキャッシュ
--
-- 詳細: docs/source/98_tasks/2026-07-18-vector-search-pagination-redesign/index.md

-- ────────────────────────────────────
-- 共通パラメータ
--   embedding は VECTOR(2048)。JSON 配列文字列で渡す（sqlx 実装と同じ）。
--   playground では全 0 のダミーを 2048 個並べたい場合は
--     SET @v = CONCAT('[', REPEAT('0,', 2047), '0]');
--   のように組み立てるとよい。
--
--   LIMIT / OFFSET は MySQL / TiDB 仕様で @var を受け付けないため
--   （リテラル整数 or prepared placeholder のみ）、
--   `LIMIT 1000` (固定候補窓) / `LIMIT 10 OFFSET 0` (page) を直接書き換える
--   （page N は OFFSET (N-1)*10。候補窓の 1000 はページによらず固定のまま）。
-- ────────────────────────────────────

SET @user_name = 'shuntaka';
SET @vector    = CONCAT('[', REPEAT('0,', 2047), '0]');


-- ────────────────────────────────────
-- (A) 検索のみ（タグ無し）: HNSW ANN + 固定候補窓
--   nearest_chunks の LIMIT 1000 は SEARCH_CANDIDATE_POOL 定数。
--   offset が変わっても窓は変えない。これが旧方式との唯一かつ本質的な違い。
-- ────────────────────────────────────

WITH nearest_chunks AS (
    SELECT /*+ READ_FROM_STORAGE(TIFLASH[c]) */
           c.article_id,
           VEC_COSINE_DISTANCE(c.embedding, @vector) AS distance
      FROM article_embedding_chunks AS c
     ORDER BY VEC_COSINE_DISTANCE(c.embedding, @vector)
     LIMIT 1000
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
       COUNT(*) OVER() AS total_count  -- 固定窓内のユニーク記事数。offset を変えても不変
  FROM ranked_articles
 WHERE chunk_rank = 1
 ORDER BY distance, article_id
 LIMIT 10 OFFSET 0;


-- ────────────────────────────────────
-- (B) 検索 + タグ 2 件 AND: pre-filter + exact
--   scored CTE の WHERE に EXISTS を積む（距離計算前の pre-filter）。
--   タグで絞った小集合が対象なので HNSW 不使用の総当たりで成立する。
-- ────────────────────────────────────

SELECT tag_id INTO @tag_id_a FROM tags WHERE name = 'tech';
SELECT tag_id INTO @tag_id_b FROM tags WHERE name = 'misc';

WITH RECURSIVE tag_descendants AS (
    SELECT tag_id, tag_id AS root_tag_id FROM tags WHERE tag_id IN (@tag_id_a, @tag_id_b)
    UNION ALL
    SELECT t.tag_id, td.root_tag_id FROM tags t
    JOIN tag_descendants td ON t.parent_tag_id = td.tag_id
),
scored AS (
    SELECT /*+ READ_FROM_STORAGE(TIFLASH[c]) */
           c.article_id,
           MIN(VEC_COSINE_DISTANCE(c.embedding, @vector)) AS distance
      FROM article_embedding_chunks AS c
      JOIN articles AS a ON a.article_id = c.article_id
      JOIN users    AS u ON u.user_id    = a.user_id
     WHERE a.status = 'published'
       AND u.name   = @user_name
       AND EXISTS (SELECT 1 FROM articles_tags at0
                     JOIN tag_descendants td ON at0.tag_id = td.tag_id AND td.root_tag_id = @tag_id_a
                    WHERE at0.article_id = a.article_id)
       AND EXISTS (SELECT 1 FROM articles_tags at1
                     JOIN tag_descendants td ON at1.tag_id = td.tag_id AND td.root_tag_id = @tag_id_b
                    WHERE at1.article_id = a.article_id)
     GROUP BY c.article_id
)
SELECT a.article_id, a.title, a.slug, a.user_id, a.thumbnail, a.description,
       a.status, a.published_at, a.created_at, a.updated_at, s.distance,
       COUNT(*) OVER() AS total_count  -- 真値。タグファセットの件数と一致する
  FROM scored AS s
  JOIN articles AS a ON a.article_id = s.article_id
 ORDER BY s.distance, a.article_id
 LIMIT 10 OFFSET 0;


-- ────────────────────────────────────
-- (C) 検索 + タグ 2 件 OR: pre-filter + exact
-- ────────────────────────────────────

WITH RECURSIVE tag_descendants AS (
    SELECT tag_id FROM tags WHERE tag_id IN (@tag_id_a, @tag_id_b)
    UNION ALL
    SELECT t.tag_id FROM tags t
    JOIN tag_descendants td ON t.parent_tag_id = td.tag_id
),
scored AS (
    SELECT /*+ READ_FROM_STORAGE(TIFLASH[c]) */
           c.article_id,
           MIN(VEC_COSINE_DISTANCE(c.embedding, @vector)) AS distance
      FROM article_embedding_chunks AS c
      JOIN articles AS a ON a.article_id = c.article_id
      JOIN users    AS u ON u.user_id    = a.user_id
     WHERE a.status = 'published'
       AND u.name   = @user_name
       AND EXISTS (SELECT 1 FROM articles_tags ats
                     JOIN tag_descendants td ON ats.tag_id = td.tag_id
                    WHERE ats.article_id = a.article_id)
     GROUP BY c.article_id
)
SELECT a.article_id, a.title, a.slug, a.user_id, a.thumbnail, a.description,
       a.status, a.published_at, a.created_at, a.updated_at, s.distance,
       COUNT(*) OVER() AS total_count
  FROM scored AS s
  JOIN articles AS a ON a.article_id = s.article_id
 ORDER BY s.distance, a.article_id
 LIMIT 10 OFFSET 0;


-- ────────────────────────────────────
-- (D) ページネーションの決定性確認
--   (A) または (B) の `LIMIT 10 OFFSET 0` を `OFFSET 10` に変えて 2 回流し、
--   * total_count が両方で同じ値になること（(A) は窓の 1000 を変えないこと）
--   * page1 の末尾と page2 の先頭で記事が重複・欠落しないこと
--   を確認できる。旧方式（11_ann_candidate_window_problem.sql）との対比用。
-- ────────────────────────────────────
