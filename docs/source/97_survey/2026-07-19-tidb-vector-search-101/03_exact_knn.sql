-- Step 3: exact kNN = 全行と距離計算してソートする検索（brute force）
--
-- 「クエリベクトルに近い k 件」を求める一番素朴な方法。
--   * 全行の距離を計算する → コストは行数に比例 O(N)
--   * その代わり結果は 100% 正確
-- SQL では「ORDER BY 距離関数 LIMIT k」がそのまま exact kNN になる。

-- (1) クエリ「DB について知りたい」= [1,0,0,0]（db 成分だけのベクトル）
--   期待値: mysql-tuning 0.0077 / tidb-intro 0.0238 / embedding-search 0.3492
--   → DB 成分が濃い行から順に並ぶ
SELECT id, label,
       ROUND(VEC_COSINE_DISTANCE(embedding, '[1,0,0,0]'), 4) AS distance
  FROM vec_lesson
 ORDER BY VEC_COSINE_DISTANCE(embedding, '[1,0,0,0]')
 LIMIT 3;

-- (2) クエリ「DB × ML」= [1,0,0,1]
--   期待値: embedding-search 0.0029 / llm-rag 0.0958 / mysql-tuning 0.2984
--   → 成分の混ざり方が近い行が浮上する。キーワード一致では出せない並び
SELECT id, label,
       ROUND(VEC_COSINE_DISTANCE(embedding, '[1,0,0,1]'), 4) AS distance
  FROM vec_lesson
 ORDER BY VEC_COSINE_DISTANCE(embedding, '[1,0,0,1]')
 LIMIT 3;

-- (3) EXPLAIN で「全行走査している」ことを確認
--   期待値: TableFullScan が task = cop[tikv] に出る。annIndex の文字は無い
--   → インデックスを使わず TiKV（行ストア）で総当たりしている
EXPLAIN
SELECT id, label, VEC_COSINE_DISTANCE(embedding, '[1,0,0,0]') AS distance
  FROM vec_lesson
 ORDER BY VEC_COSINE_DISTANCE(embedding, '[1,0,0,0]')
 LIMIT 3;
