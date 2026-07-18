-- Step 4: ベクトル検索と TiFlash — HNSW の置き場所を用意する
--
-- TiFlash の性質（列指向、レプリカ宣言、ヒントで向ける）は Step 1 でやった通り。
-- ここではそれをベクトル検索に当てはめる。
--   * ベクトル距離計算は「全行 × embedding 列だけ」を舐める処理 = 列指向の得意な形
--   * さらに TiDB のベクトルインデックス（HNSW）は TiFlash 上にしか作れない
-- ので、まず vec_lesson にレプリカを張って置き場所を用意する。

-- (1) レプリカ宣言（Step 1 と同じ操作）
ALTER TABLE vec_lesson SET TIFLASH REPLICA 1;

-- (2) available = 1 かつ progress = 1 になるまで待つ（8 行なら数秒）
SELECT table_name, replica_count, available, progress
  FROM information_schema.tiflash_replica
 WHERE table_name = 'vec_lesson';

-- (3) Step 3 の exact kNN クエリを TiFlash に向けて、EXPLAIN の task 列を見る
--   期待値: TableFullScan の task が cop[tikv] → mpp[tiflash] に変わる
--
--   ★ここが重要: TiFlash に向けてもまだ TableFullScan = 総当たりのまま。
--     列指向で「全行 × embedding 列」を読むのが速くなっただけで、
--     全行の距離計算 O(N) という構造は変わっていない。
--     行数そのものを減らすのが HNSW インデックス（次の Step 5）。
EXPLAIN
SELECT /*+ READ_FROM_STORAGE(TIFLASH[vec_lesson]) */
       id, label, VEC_COSINE_DISTANCE(embedding, '[1,0,0,0]') AS distance
  FROM vec_lesson
 ORDER BY VEC_COSINE_DISTANCE(embedding, '[1,0,0,0]')
 LIMIT 3;
