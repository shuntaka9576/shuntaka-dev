-- 出典: 旧実装 (〜2026-07-18) の search_published_by_user_name。現行コードには存在しない。
-- 関連: docs/source/98_tasks/2026-07-18-vector-search-pagination-redesign/index.md
--
-- ANN (HNSW) 方式で total_count が「候補窓」の中でしか数えられない問題の再現 SQL。
-- ※ この問題は現行方式（08_users_articles_search.sql）で解消済み。
--   検索のみ: 候補窓を offset 連動から定数 1000 に固定 / 検索+タグ: pre-filter + exact。
--   本ファイルは「なぜ offset 連動の候補窓が破綻するか」を実データで確認するために残している。
--
-- 旧実装は candidate_limit = (limit + offset) × multiplier で ANN 候補チャンク数を決めていた。
-- つまり候補窓のサイズが offset に比例して広がるため、
--   ページ1 (offset=0)  → 候補窓 100 チャンク → その中のユニーク記事数が total_count
--   ページ2 (offset=10) → 候補窓 200 チャンク → total_count が増える
-- となり、ページを進めるたびに総件数（＝総ページ数）が変わってしまう。
--
-- 以下の 2 クエリは candidate window (nearest_chunks の LIMIT) だけが異なる。
-- 実データで流すと、窓が広いほど total_count が大きくなることを確認できる。
-- （コーパス全チャンク数より窓が大きい場合は両者一致する。その場合は
--   窓 1 = 10、窓 2 = 50 のように小さくして差を作ると分かりやすい）

SET @user_name = 'shuntaka';
SET @vector    = CONCAT('[', REPEAT('0,', 2047), '0]');


-- ────────────────────────────────────
-- (1) ページ1 相当: 候補窓 100 チャンク
--     total_count = 「上位 100 チャンク内のユニーク公開記事数」でしかない
-- ────────────────────────────────────

WITH nearest_chunks AS (
    SELECT /*+ READ_FROM_STORAGE(TIFLASH[c]) */
           c.article_id,
           VEC_COSINE_DISTANCE(c.embedding, @vector) AS distance
      FROM article_embedding_chunks AS c
     ORDER BY VEC_COSINE_DISTANCE(c.embedding, @vector)
     LIMIT 100
),
ranked_articles AS (
    SELECT a.article_id, a.title, nc.distance,
           ROW_NUMBER() OVER (
               PARTITION BY a.article_id ORDER BY nc.distance, a.article_id
           ) AS chunk_rank
      FROM nearest_chunks AS nc
      JOIN articles AS a ON a.article_id = nc.article_id
      JOIN users    AS u ON u.user_id    = a.user_id
     WHERE a.status = 'published'
       AND u.name   = @user_name
)
SELECT article_id, title, distance,
       COUNT(*) OVER() AS total_count  -- ← 候補窓の中でしか数えられない
  FROM ranked_articles
 WHERE chunk_rank = 1
 ORDER BY distance, article_id
 LIMIT 10 OFFSET 0;


-- ────────────────────────────────────
-- (2) ページ2 相当: 候補窓 200 チャンク（offset が増えた分、窓が広がる）
--     同じクエリなのに total_count が (1) より大きくなりうる
--     → フロントが総ページ数を再計算すると、ページを進めるたびにページ数が増殖する
-- ────────────────────────────────────

WITH nearest_chunks AS (
    SELECT /*+ READ_FROM_STORAGE(TIFLASH[c]) */
           c.article_id,
           VEC_COSINE_DISTANCE(c.embedding, @vector) AS distance
      FROM article_embedding_chunks AS c
     ORDER BY VEC_COSINE_DISTANCE(c.embedding, @vector)
     LIMIT 200
),
ranked_articles AS (
    SELECT a.article_id, a.title, nc.distance,
           ROW_NUMBER() OVER (
               PARTITION BY a.article_id ORDER BY nc.distance, a.article_id
           ) AS chunk_rank
      FROM nearest_chunks AS nc
      JOIN articles AS a ON a.article_id = nc.article_id
      JOIN users    AS u ON u.user_id    = a.user_id
     WHERE a.status = 'published'
       AND u.name   = @user_name
)
SELECT article_id, title, distance,
       COUNT(*) OVER() AS total_count
  FROM ranked_articles
 WHERE chunk_rank = 1
 ORDER BY distance, article_id
 LIMIT 10 OFFSET 10;
