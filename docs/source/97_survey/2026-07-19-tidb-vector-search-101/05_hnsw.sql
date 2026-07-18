-- Step 5: HNSW = 全行見ずに近傍を返す近似インデックス（ANN）
--
-- exact kNN は O(N)。行数が増えると比例して遅くなるので、
-- 「多少の取りこぼしを許容して一部の行だけ見る」近似（ANN）に切り替える。
-- HNSW は ANN の代表的実装で、ベクトルを多層グラフにしておき
-- 上層（疎・長距離エッジ）で大まかに寄せて下層（密・短距離エッジ)で精密に寄せる。
-- スキップリストのグラフ版と考えると掴みやすい。

-- (1) インデックス作成。TiFlash レプリカが前提（Step 4 を先に）
CREATE VECTOR INDEX idx_vec_lesson_embedding
  ON vec_lesson ((VEC_COSINE_DISTANCE(embedding))) USING HNSW;

-- (2) インデックスの実体を確認
--   期待値: ROWS_DELTA_NOT_INDEXED = 8（全行が未インデックス）
--   TiFlash は直近の書き込みを Delta 層に貯め、Delta 層は HNSW に入らない。
--   検索時は「Stable 層 = HNSW / Delta 層 = 総当たり」を透過的にマージするので、
--   書いた直後の行も検索には出る（インデックスが効かないだけ）
SELECT TIDB_TABLE, INDEX_NAME, ROWS_STABLE_INDEXED, ROWS_DELTA_NOT_INDEXED
  FROM INFORMATION_SCHEMA.TIFLASH_INDEXES
 WHERE TIDB_TABLE = 'vec_lesson';

-- (3) COMPACT で Delta 層を Stable 層へ落とす
ALTER TABLE vec_lesson COMPACT TIFLASH REPLICA;

-- (4) 再確認。期待値: ROWS_STABLE_INDEXED = 8, ROWS_DELTA_NOT_INDEXED = 0
--   （反映まで数秒かかることがある）
SELECT TIDB_TABLE, INDEX_NAME, ROWS_STABLE_INDEXED, ROWS_DELTA_NOT_INDEXED
  FROM INFORMATION_SCHEMA.TIFLASH_INDEXES
 WHERE TIDB_TABLE = 'vec_lesson';

-- (5) EXPLAIN ANALYZE でインデックスが効いたことを確認
--   期待値: TableFullScan の operator info に annIndex:COSINE(..., limit:3) が付き、
--           execution info に vector_idx:{...search:{visited_nodes:8...}} が出る
--
--   annIndex が出れば HNSW 経由。8 行しかないので visited_nodes = 8（全ノード訪問）
--   となり旨味はゼロだが、「効いているかは annIndex と visited_nodes で判定する」
--   という読み方はこのサイズで覚えられる。実データでの差は 07_real_data.sql で見る。
--
--   効かせる条件は「ORDER BY 距離関数 LIMIT k」の形を崩さないこと。
--   WHERE を足したり式を変形すると外れやすい（外れると Step 3 と同じ総当たりに戻る）。
EXPLAIN ANALYZE
SELECT /*+ READ_FROM_STORAGE(TIFLASH[vec_lesson]) */
       id, label, VEC_COSINE_DISTANCE(embedding, '[1,0,0,0]') AS distance
  FROM vec_lesson
 ORDER BY VEC_COSINE_DISTANCE(embedding, '[1,0,0,0]')
 LIMIT 3;
