-- Step 1: TiFlash 単体 — 列指向だからできること
--
-- ベクトルの前に、TiFlash そのものを一番単純な形で体感する。
-- 行ストア（TiKV）と列ストア（TiFlash）はデータの物理的な並べ方が違う。
--   * 行ストア: 1 行分の全列がディスク上で連続。「id=54321 の行を丸ごと 1 件」が得意
--   * 列ストア: 1 列分の全行が連続。「全行のうち 2 列だけ舐めて集計」が得意
-- これを見るために、集計に使う細い列（category, amount）と、集計には無関係な
-- 太い列（note 500 バイト）を持つテーブルを 10 万行作る。

-- (1) 実験台を作る。行生成は再帰 CTE で 0〜9 を作り 5 桁分掛け合わせて 10 万行
--     （再帰 CTE 自体は Step 6 で学ぶ。ここでは行ジェネレータとして使うだけ）
DROP TABLE IF EXISTS sales_lesson;
CREATE TABLE sales_lesson (
  id INT PRIMARY KEY,
  category VARCHAR(20) NOT NULL,
  amount INT NOT NULL,
  note TEXT NOT NULL          -- 500 バイトの詰め物。行を太らせるためだけの列
);

INSERT INTO sales_lesson
WITH RECURSIVE d AS (SELECT 0 AS n UNION ALL SELECT n + 1 FROM d WHERE n < 9)
SELECT d1.n + d2.n*10 + d3.n*100 + d4.n*1000 + d5.n*10000 AS id,
       ELT(1 + (d1.n + d2.n*10 + d3.n*100 + d4.n*1000 + d5.n*10000) % 5,
           'food','book','game','music','travel') AS category,
       (d1.n + d2.n*10 + d3.n*100 + d4.n*1000 + d5.n*10000) % 10000 AS amount,
       REPEAT('x', 500) AS note
  FROM d d1, d d2, d d3, d d4, d d5;

-- (2) TiFlash レプリカを宣言して同期を待つ
--   available = 1 かつ progress = 1 になるまで数秒〜数十秒（テーブル約 50MB）
ALTER TABLE sales_lesson SET TIFLASH REPLICA 1;

SELECT table_name, replica_count, available, progress
  FROM information_schema.tiflash_replica
 WHERE table_name = 'sales_lesson';

-- (3) 列指向の得意技: 少数列の全行集計
--   まず TiKV（行ストア）で。行ストアは行単位でしか読めないので、
--   category と amount しか使わない集計でも note 500B を含む全行 約 50MB を読む。
--   期待値 (実測 2026-07-19): 157.8ms、TableFullScan actRows = 100000 が cop[tikv]
EXPLAIN ANALYZE
SELECT /*+ READ_FROM_STORAGE(TIKV[sales_lesson]) */
       category, COUNT(*) AS cnt, AVG(amount) AS avg_amount
  FROM sales_lesson
 GROUP BY category;

--   次に同じ集計を TiFlash（列ストア）で。列ごとにファイルが分かれているので
--   category と amount の 2 列だけ読めば済み、note の 50MB は一切触らない。
--   期待値 (同上): 13.3ms（約 1/12）。プランは mpp[tiflash] + threads:16 の並列
EXPLAIN ANALYZE
SELECT /*+ READ_FROM_STORAGE(TIFLASH[sales_lesson]) */
       category, COUNT(*) AS cnt, AVG(amount) AS avg_amount
  FROM sales_lesson
 GROUP BY category;

--   結果はどちらも同じ（category 5 種 × 各 20000 行）
SELECT /*+ READ_FROM_STORAGE(TIFLASH[sales_lesson]) */
       category, COUNT(*) AS cnt, AVG(amount) AS avg_amount
  FROM sales_lesson
 GROUP BY category
 ORDER BY category;

-- (4) 逆方向: 1 行の点読みは行ストアの得意技
--   期待値 (同上): Point_Get 1.7ms。PK で 1 行を直接取る最速パス
EXPLAIN ANALYZE
SELECT id, category, amount FROM sales_lesson WHERE id = 54321;

--   TIFLASH ヒントを付けても Point_Get のまま変わらない。
--   オプティマイザは「点読みを TiFlash に向ける」選択肢をそもそも採らない
EXPLAIN ANALYZE
SELECT /*+ READ_FROM_STORAGE(TIFLASH[sales_lesson]) */
       id, category, amount FROM sales_lesson WHERE id = 54321;

--   セッション変数で TiFlash しか使えないよう縛ると初めて TiFlash に行くが、
--   TableRangeScan になり 9.2ms（Point_Get の約 5 倍）。列ストアには
--   「1 行を丸ごとすぐ返す」ための行単位インデックスが無い。
--   試したら SET SESSION ... = 'tikv,tiflash,tidb' で必ず戻すこと
SET SESSION tidb_isolation_read_engines = 'tiflash';
EXPLAIN ANALYZE
SELECT id, category, amount FROM sales_lesson WHERE id = 54321;
SET SESSION tidb_isolation_read_engines = 'tikv,tiflash,tidb';

-- まとめ: 同じテーブルでも「全行×少数列」は列ストア、「1 行×全列」は行ストアが勝つ。
-- TiDB は両方をレプリカとして持ち、クエリごとに使い分けられるのが特徴。
-- ベクトル検索(2048 次元の embedding 列を全行舐めて距離計算)は「全行×少数列」の
-- 極端な例なので TiFlash 向き、というのが以降のステップにつながる。
-- sales_lesson はもう使わない。99_cleanup.sql で削除する
