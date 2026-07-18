-- Step 7: 実データで exact と HNSW の差を見る
--
-- 教材テーブル（8 行）では差が出ないので、本物の article_embedding_chunks
-- （2048 次元 PLaMo Embedding、約 1,100 chunk）で同じクエリを 2 通り流す。
--   * TIKV ヒント    → TiKV にはベクトルインデックスが無いので必ず exact（総当たり）
--   * TIFLASH ヒント → HNSW インデックス経由
--
-- 2048 次元のダミーベクトルはセッション変数で組み立てる（全 0 は NULL になるため
-- 先頭だけ 1）。playground はステートメントごとに接続を切ることがあるので、
-- BEGIN ... COMMIT で括って SET と本体を同一トランザクションで送る。

-- (1) exact: 総当たり
--   実測 (2026-07-19, blog_dev 1,108 chunks): 89.7ms。
--   TableFullScan actRows = 1108 = 全行の 2048 次元距離計算
BEGIN;
SET @vector = CONCAT('[1,', REPEAT('0,', 2046), '0]');
EXPLAIN ANALYZE
SELECT /*+ READ_FROM_STORAGE(TIKV[c]) */
       c.article_id, VEC_COSINE_DISTANCE(c.embedding, @vector) AS distance
  FROM article_embedding_chunks AS c
 ORDER BY VEC_COSINE_DISTANCE(c.embedding, @vector)
 LIMIT 5;
COMMIT;

-- (2) HNSW: グラフを辿って一部だけ見る
--   実測 (同上): 9.3ms、visited_nodes:68（1,101 ノード中 68 ノードだけ訪問）
--   同じ top-5 を約 1/10 の時間で返す。行数が増えるほどこの差は開く（exact は O(N)）
BEGIN;
SET @vector = CONCAT('[1,', REPEAT('0,', 2046), '0]');
EXPLAIN ANALYZE
SELECT /*+ READ_FROM_STORAGE(TIFLASH[c]) */
       c.article_id, VEC_COSINE_DISTANCE(c.embedding, @vector) AS distance
  FROM article_embedding_chunks AS c
 ORDER BY VEC_COSINE_DISTANCE(c.embedding, @vector)
 LIMIT 5;
COMMIT;

-- (3) 結果は同じか（= 近似の取りこぼし確認）
--   実測 (同上): top-5 の chunk_id と距離が完全一致。この規模なら recall 100%。
--   件数が増えると HNSW は取りこぼしうるので、本番クエリは必要数より多めに取る
--   （over-fetch）+ 後段フィルタで吸収する設計にしている
BEGIN;
SET @vector = CONCAT('[1,', REPEAT('0,', 2046), '0]');
SELECT /*+ READ_FROM_STORAGE(TIKV[c]) */
       'exact' AS mode, c.chunk_id, ROUND(VEC_COSINE_DISTANCE(c.embedding, @vector), 6) AS distance
  FROM article_embedding_chunks AS c
 ORDER BY VEC_COSINE_DISTANCE(c.embedding, @vector)
 LIMIT 5;
SELECT /*+ READ_FROM_STORAGE(TIFLASH[c]) */
       'hnsw' AS mode, c.chunk_id, ROUND(VEC_COSINE_DISTANCE(c.embedding, @vector), 6) AS distance
  FROM article_embedding_chunks AS c
 ORDER BY VEC_COSINE_DISTANCE(c.embedding, @vector)
 LIMIT 5;
COMMIT;
