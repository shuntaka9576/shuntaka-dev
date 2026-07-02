-- ====================================================================
-- Phase 4: 一覧クエリの JOIN 分離 + 複合インデックス拡張の検証 SQL
-- ====================================================================
-- 対象 DB: blog_dev
-- 想定 user_name: shuntaka
-- 実行手順:
--   1) scripts/exec-tidb-proxy.sh で proxy コンテナに入る
--      ( $ apk add --no-cache mysql-client    # 未導入なら )
--   2) mysql -h localhost -P 13306 -u blog_dev -p blog_dev
--   3) 以下を上から順番に流し、結果をすべてフル出力で残す
--      (mysql クライアントなら `tee /tmp/phase4.log` でファイル保存可)
--
-- 比較対象:
--   A. Baseline = 現状のクエリ (JOIN あり + ORDER BY published_at DESC)
--      + 既存インデックス idx_articles_user_status_type_published_at
--   B. Phase 4 = 新クエリ (JOIN 分離 + ORDER BY published_at DESC, article_id DESC)
--      + 新インデックス idx_articles_user_status_type_published_at_id
-- ====================================================================

USE blog_dev;

-- --------------------------------------------------------------------
-- 0. 事前情報: 現状のインデックス
-- --------------------------------------------------------------------
SHOW INDEX FROM articles;

-- --------------------------------------------------------------------
-- A. Baseline: 現状のクエリ (JOIN + ORDER BY published_at DESC + LIMIT 10)
--    既存インデックス idx_articles_user_status_type_published_at が選ばれる想定
-- --------------------------------------------------------------------

-- A-1. 一覧 (LIMIT 10 OFFSET 0 = 1 ページ目)
EXPLAIN ANALYZE
SELECT
  a.article_id,
  a.title,
  a.slug,
  a.user_id,
  a.thumbnail,
  a.description,
  a.status,
  a.`type`,
  a.published_at,
  a.created_at,
  a.updated_at
FROM articles a
JOIN users u ON a.user_id = u.user_id
WHERE a.status = 'published'
  AND a.`type` = 'tech'
  AND u.name = 'shuntaka'
ORDER BY a.published_at DESC
LIMIT 10 OFFSET 0;
-- TopN_15	0.04	10	root		time:2.75ms, loops:2, RU:7.736557	blog_dev.articles.published_at:desc, offset:0, count:10	18.4 KB	N/A
-- └─IndexHashJoin_26	0.04	37	root		time:2.73ms, loops:2, inner:{total:1.72ms, concurrency:5, task:1, construct:3.78µs, fetch:1.68ms, build:9.93µs, join:30.9µs}	inner join, inner:IndexLookUp_23, outer key:blog_dev.users.user_id, inner key:blog_dev.articles.user_id, equal cond:eq(blog_dev.users.user_id, blog_dev.articles.user_id)	187.9 KB	N/A
--   ├─Point_Get_34(Build)	1.00	1	root	table:users, index:uq_users_name(name)	time:945.2µs, loops:3, Get:{num_rpc:2, total_time:890.2µs}, time_detail: {total_process_time: 92.8µs, total_wait_time: 109µs, total_kv_read_wall_time: 207.3µs, tikv_wall_time: 245.9µs}, scan_detail: {total_process_keys: 2, total_process_keys_size: 250, total_keys: 2, get_snapshot_time: 18.3µs, rocksdb: {block: {cache_hit_count: 6}}}		N/A	N/A
--   └─IndexLookUp_23(Probe)	38.34	37	root		time:1.64ms, loops:2, index_task: {total_time: 415.9µs, fetch_handle: 414.8µs, build: 541ns, wait: 541ns}, table_task: {total_time: 1.14ms, num: 1, concurrency: 5}, next: {wait_index: 500.4µs, wait_table_lookup_build: 26.2µs, wait_table_lookup_resp: 1.09ms}		47.4 KB	N/A
--     ├─IndexRangeScan_21(Build)	38.34	37	cop[tikv]	table:a, index:idx_articles_user_status_type_published_at(user_id, status, type, published_at)	time:389.1µs, loops:3, cop_task: {num: 1, max: 351.8µs, proc_keys: 37, tot_proc: 92.8µs, tot_wait: 28.3µs, copr_cache_hit_ratio: 0.00, build_task_duration: 11.6µs, max_distsql_concurrency: 1}, rpc_info:{Cop:{num_rpc:1, total_time:344.1µs}}, tikv_task:{time:0s, loops:2}, scan_detail: {total_process_keys: 37, total_process_keys_size: 6956, total_keys: 38, get_snapshot_time: 10.9µs, rocksdb: {key_skipped_count: 37, block: {cache_hit_count: 3}}}, time_detail: {total_process_time: 92.8µs, total_wait_time: 28.3µs, tikv_wall_time: 189.4µs}	range: decided by [eq(blog_dev.articles.user_id, blog_dev.users.user_id) eq(blog_dev.articles.status, published) eq(blog_dev.articles.type, tech)], keep order:false	N/A	N/A
--     └─TableRowIDScan_22(Probe)	38.34	37	cop[tikv]	table:a	time:1.08ms, loops:2, cop_task: {num: 1, max: 1.03ms, proc_keys: 37, tot_proc: 721.8µs, tot_wait: 21.3µs, copr_cache_hit_ratio: 0.00, build_task_duration: 15.5µs, max_distsql_concurrency: 1}, rpc_info:{Cop:{num_rpc:1, total_time:1.02ms}}, tikv_task:{time:0s, loops:2}, scan_detail: {total_process_keys: 37, total_process_keys_size: 355476, total_keys: 74, get_snapshot_time: 8.26µs, rocksdb: {key_skipped_count: 37, block: {cache_hit_count: 148}}}, time_detail: {total_process_time: 721.8µs, total_wait_time: 21.3µs, tikv_wall_time: 834.9µs}	keep order:false	N/A	N/A

-- A-2. COUNT(*)
EXPLAIN ANALYZE
SELECT COUNT(*)
FROM articles a
JOIN users u ON a.user_id = u.user_id
WHERE a.status = 'published'
  AND a.`type` = 'tech'
  AND u.name = 'shuntaka';

-- StreamAgg_12	1.00	1	root		time:1.67ms, loops:2, RU:1.633007	funcs:count(1)->Column#19	8 Bytes	N/A
-- └─IndexHashJoin_17	0.04	37	root		time:1.66ms, loops:2, inner:{total:620.6µs, concurrency:5, task:1, construct:3.61µs, fetch:596.8µs, build:7.94µs, join:18.4µs}	inner join, inner:IndexReader_14, outer key:blog_dev.users.user_id, inner key:blog_dev.articles.user_id, equal cond:eq(blog_dev.users.user_id, blog_dev.articles.user_id)	82.0 KB	N/A
--   ├─Point_Get_24(Build)	1.00	1	root	table:users, index:uq_users_name(name)	time:935.5µs, loops:3, Get:{num_rpc:2, total_time:884.8µs}, time_detail: {total_process_time: 129.4µs, total_wait_time: 98.7µs, total_kv_read_wall_time: 236.5µs, tikv_wall_time: 287µs}, scan_detail: {total_process_keys: 2, total_process_keys_size: 250, total_keys: 2, get_snapshot_time: 25µs, rocksdb: {block: {cache_hit_count: 6}}}		N/A	N/A
--   └─IndexReader_14(Probe)	38.34	37	root		time:544.8µs, loops:2, cop_task: {num: 1, max: 481.6µs, proc_keys: 37, tot_proc: 164.7µs, tot_wait: 36.3µs, copr_cache_hit_ratio: 0.00, build_task_duration: 3.11µs, max_distsql_concurrency: 1}, rpc_info:{Cop:{num_rpc:1, total_time:469.7µs}}	index:IndexRangeScan_13	3.05 KB	N/A
--     └─IndexRangeScan_13	38.34	37	cop[tikv]	table:a, index:idx_articles_user_status_type_published_at(user_id, status, type, published_at)	tikv_task:{time:0s, loops:2}, scan_detail: {total_process_keys: 37, total_process_keys_size: 6956, total_keys: 38, get_snapshot_time: 17.5µs, rocksdb: {key_skipped_count: 37, block: {cache_hit_count: 3}}}, time_detail: {total_process_time: 164.7µs, total_wait_time: 36.3µs, tikv_wall_time: 279.4µs}	range: decided by [eq(blog_dev.articles.user_id, blog_dev.users.user_id) eq(blog_dev.articles.status, published) eq(blog_dev.articles.type, tech)], keep order:false	N/A	N/A

-- --------------------------------------------------------------------
-- B. Phase 4: 新インデックス追加 + 新クエリ (JOIN 分離 + ORDER BY 安定化)
-- --------------------------------------------------------------------

-- B-0. 新インデックス追加 (article_id を末尾に足したもの)
ALTER TABLE articles
  ADD INDEX idx_articles_user_status_type_published_at_id
    (user_id, status, `type`, published_at, article_id);

-- B-0-2. 統計を更新 (opt が新インデックスを選ぶように)
ANALYZE TABLE articles;

-- B-0-3. インデックス状態の再確認
SHOW INDEX FROM articles;

-- B-1. user_id 確定 (JOIN を分離した時の 1 段目)
EXPLAIN ANALYZE
SELECT user_id FROM users WHERE name = 'shuntaka';

-- Point_Get_1	1.00	1	root	table:users, index:uq_users_name(name)	time:831.7µs, loops:2, RU:0.983411, Get:{num_rpc:2, total_time:770.1µs}, time_detail: {total_process_time: 88.8µs, total_wait_time: 64µs, total_kv_read_wall_time: 158µs, tikv_wall_time: 189.1µs}, scan_detail: {total_process_keys: 2, total_process_keys_size: 250, total_keys: 2, get_snapshot_time: 16.7µs, rocksdb: {block: {cache_hit_count: 6}}}		N/A	N/A

-- B-2. articles 単表 + ORDER BY 安定化 (LIMIT 10 OFFSET 0)
--      実 user_id を埋め込んで実行する。B-1 の結果 (uuid 文字列) を以下の '<USER_ID>' に差し替える。
--      mysql のセッション変数を使う形でも OK:
--      SET @uid := (SELECT user_id FROM users WHERE name = 'shuntaka');
--      その上で a.user_id = @uid と書く。
EXPLAIN ANALYZE
SELECT
  a.article_id,
  a.title,
  a.slug,
  a.user_id,
  a.thumbnail,
  a.description,
  a.status,
  a.`type`,
  a.published_at,
  a.created_at,
  a.updated_at
FROM articles a
WHERE a.user_id = (SELECT user_id FROM users WHERE name = 'shuntaka')
  AND a.status = 'published'
  AND a.`type` = 'tech'
ORDER BY a.published_at DESC, a.article_id DESC
LIMIT 10 OFFSET 0;

-- # id	estRows	actRows	task	access object	execution info	operator info	memory	disk
-- IndexLookUp_33	10.00	10	root		time:1.75ms, loops:2, RU:3.881495, index_task: {total_time: 1.17ms, fetch_handle: 1.16ms, build: 4.15µs, wait: 1.89µs}, table_task: {total_time: 517.7µs, num: 1, concurrency: 5}, next: {wait_index: 1.21ms, wait_table_lookup_build: 44.8µs, wait_table_lookup_resp: 476.2µs}	limit embedded(offset:0, count:10)	28.6 KB	N/A
-- ├─Limit_32(Build)	10.00	10	cop[tikv]		time:1.16ms, loops:1, cop_task: {num: 2, max: 716µs, min: 403.2µs, avg: 559.6µs, p95: 716µs, max_proc_keys: 10, p95_proc_keys: 10, tot_proc: 164.5µs, tot_wait: 394.9µs, copr_cache_hit_ratio: 0.00, build_task_duration: 10.6µs, max_distsql_concurrency: 1}, rpc_info:{Cop:{num_rpc:2, total_time:1.1ms}}, tikv_task:{proc max:0s, min:0s, avg: 0s, p80:0s, p95:0s, iters:2, tasks:2}, scan_detail: {total_process_keys: 10, total_process_keys_size: 2420, total_keys: 12, get_snapshot_time: 361.4µs, rocksdb: {key_skipped_count: 11, block: {cache_hit_count: 10}}}, time_detail: {total_process_time: 164.5µs, total_wait_time: 394.9µs, tikv_wall_time: 706.7µs}	offset:0, count:10	N/A	N/A
-- │ └─IndexRangeScan_30	10.00	10	cop[tikv]	table:a, index:idx_articles_user_status_type_published_at_id(user_id, status, type, published_at, article_id)	tikv_task:{proc max:0s, min:0s, avg: 0s, p80:0s, p95:0s, iters:2, tasks:2}	range:["00000000-0000-0000-0000-000000000002" "published" "tech","00000000-0000-0000-0000-000000000002" "published" "tech"], keep order:true, desc	N/A	N/A
-- └─TableRowIDScan_31(Probe)	10.00	10	cop[tikv]	table:a	time:457µs, loops:2, cop_task: {num: 1, max: 422.1µs, proc_keys: 10, tot_proc: 205.9µs, tot_wait: 19.9µs, copr_cache_hit_ratio: 0.00, build_task_duration: 13.1µs, max_distsql_concurrency: 1, max_extra_concurrency: 1}, rpc_info:{Cop:{num_rpc:1, total_time:414.2µs}}, tikv_task:{time:0s, loops:1}, scan_detail: {total_process_keys: 10, total_process_keys_size: 83220, total_keys: 20, get_snapshot_time: 8.39µs, rocksdb: {key_skipped_count: 10, block: {cache_hit_count: 40}}}, time_detail: {total_process_time: 205.9µs, total_wait_time: 19.9µs, tikv_wall_time: 283.5µs}	keep order:false	N/A	N/A


-- B-3. COUNT(*) も articles 単表に
EXPLAIN ANALYZE
SELECT COUNT(*)
FROM articles a
WHERE a.user_id = (SELECT user_id FROM users WHERE name = 'shuntaka')
  AND a.status = 'published'
  AND a.`type` = 'tech';

-- StreamAgg_28	1.00	1	root		time:892.8µs, loops:2, RU:1.630549	funcs:count(Column#30)->Column#19	388 Bytes	N/A
-- └─IndexReader_29	1.00	1	root		time:888µs, loops:2, cop_task: {num: 1, max: 845.3µs, proc_keys: 37, tot_proc: 151.4µs, tot_wait: 383.4µs, copr_cache_hit_ratio: 0.00, build_task_duration: 4.78µs, max_distsql_concurrency: 1}, rpc_info:{Cop:{num_rpc:1, total_time:833.6µs}}	index:StreamAgg_16	346 Bytes	N/A
--   └─StreamAgg_16	1.00	1	cop[tikv]		tikv_task:{time:0s, loops:1}, scan_detail: {total_process_keys: 37, total_process_keys_size: 6956, total_keys: 38, get_snapshot_time: 362µs, rocksdb: {key_skipped_count: 37, block: {cache_hit_count: 3}}}, time_detail: {total_process_time: 151.4µs, total_wait_time: 383.4µs, tikv_wall_time: 646.3µs}	funcs:count(1)->Column#30	N/A	N/A
--     └─IndexRangeScan_26	47.16	37	cop[tikv]	table:a, index:idx_articles_user_status_type_published_at(user_id, status, type, published_at)	tikv_task:{time:0s, loops:1}	range:["00000000-0000-0000-0000-000000000002" "published" "tech","00000000-0000-0000-0000-000000000002" "published" "tech"], keep order:false	N/A	N/A

-- B-4. (参考) ORDER_INDEX ヒントで keep order:true を強制するパターン
EXPLAIN ANALYZE
SELECT /*+ ORDER_INDEX(a, idx_articles_user_status_type_published_at_id) */
  a.article_id,
  a.title,
  a.slug,
  a.user_id,
  a.thumbnail,
  a.description,
  a.status,
  a.`type`,
  a.published_at,
  a.created_at,
  a.updated_at
FROM articles a
WHERE a.user_id = (SELECT user_id FROM users WHERE name = 'shuntaka')
  AND a.status = 'published'
  AND a.`type` = 'tech'
ORDER BY a.published_at DESC, a.article_id DESC
LIMIT 10 OFFSET 0;

-- IndexLookUp_23	10.00	10	root		time:1.65ms, loops:2, RU:3.863825, index_task: {total_time: 999.4µs, fetch_handle: 993.5µs, build: 3.94µs, wait: 2µs}, table_task: {total_time: 586.1µs, num: 1, concurrency: 5}, next: {wait_index: 1.05ms, wait_table_lookup_build: 52.9µs, wait_table_lookup_resp: 534.4µs}	limit embedded(offset:0, count:10)	28.6 KB	N/A
-- ├─Limit_22(Build)	10.00	10	cop[tikv]		time:984.1µs, loops:1, cop_task: {num: 2, max: 673.8µs, min: 277.8µs, avg: 475.8µs, p95: 673.8µs, max_proc_keys: 10, p95_proc_keys: 10, tot_proc: 118.5µs, tot_wait: 397.8µs, copr_cache_hit_ratio: 0.00, build_task_duration: 14.7µs, max_distsql_concurrency: 1}, rpc_info:{Cop:{num_rpc:2, total_time:937.4µs}}, tikv_task:{proc max:1ms, min:0s, avg: 500µs, p80:1ms, p95:1ms, iters:2, tasks:2}, scan_detail: {total_process_keys: 10, total_process_keys_size: 2420, total_keys: 12, get_snapshot_time: 353.2µs, rocksdb: {key_skipped_count: 11, block: {cache_hit_count: 10}}}, time_detail: {total_process_time: 118.5µs, total_wait_time: 397.8µs, total_kv_read_wall_time: 1ms, tikv_wall_time: 637.7µs}	offset:0, count:10	N/A	N/A
-- │ └─IndexRangeScan_20	10.00	10	cop[tikv]	table:a, index:idx_articles_user_status_type_published_at_id(user_id, status, type, published_at, article_id)	tikv_task:{proc max:1ms, min:0s, avg: 500µs, p80:1ms, p95:1ms, iters:2, tasks:2}	range:["00000000-0000-0000-0000-000000000002" "published" "tech","00000000-0000-0000-0000-000000000002" "published" "tech"], keep order:true, desc	N/A	N/A
-- └─TableRowIDScan_21(Probe)	10.00	10	cop[tikv]	table:a	time:512.7µs, loops:2, cop_task: {num: 1, max: 475.2µs, proc_keys: 10, tot_proc: 237.5µs, tot_wait: 22.8µs, copr_cache_hit_ratio: 0.00, build_task_duration: 18.9µs, max_distsql_concurrency: 1, max_extra_concurrency: 1}, rpc_info:{Cop:{num_rpc:1, total_time:467.6µs}}, tikv_task:{time:0s, loops:1}, scan_detail: {total_process_keys: 10, total_process_keys_size: 83220, total_keys: 20, get_snapshot_time: 6.72µs, rocksdb: {key_skipped_count: 10, block: {cache_hit_count: 40}}}, time_detail: {total_process_time: 237.5µs, total_wait_time: 22.8µs, tikv_wall_time: 323.8µs}	keep order:false	N/A	N/A


-- --------------------------------------------------------------------
-- C. 旧インデックスの DROP (Phase 2 と同じく ADD と同じ deploy 単位で続けて実行)
--    新インデックス idx_articles_user_status_type_published_at_id は
--    旧インデックス idx_articles_user_status_type_published_at の完全な prefix
--    なので 100% redundant。B-2 で新インデックスが選ばれていることを確認したら流す。
-- --------------------------------------------------------------------
ALTER TABLE articles DROP INDEX idx_articles_user_status_type_published_at;

-- C-2. DROP 後にもう一度統計を更新
ANALYZE TABLE articles;

-- C-3. 旧インデックス DROP 後に新クエリの計画が変わっていないことを再確認
EXPLAIN ANALYZE
SELECT
  a.article_id,
  a.title,
  a.slug,
  a.user_id,
  a.thumbnail,
  a.description,
  a.status,
  a.`type`,
  a.published_at,
  a.created_at,
  a.updated_at
FROM articles a
WHERE a.user_id = (SELECT user_id FROM users WHERE name = 'shuntaka')
  AND a.status = 'published'
  AND a.`type` = 'tech'
ORDER BY a.published_at DESC, a.article_id DESC
LIMIT 10 OFFSET 0;
-- IndexLookUp_31	10.00	10	root		time:1.77ms, loops:2, RU:3.887239, index_task: {total_time: 1.05ms, fetch_handle: 1.05ms, build: 4.11µs, wait: 2.08µs}, table_task: {total_time: 661.5µs, num: 1, concurrency: 5}, next: {wait_index: 1.1ms, wait_table_lookup_build: 50.5µs, wait_table_lookup_resp: 612.1µs}	limit embedded(offset:0, count:10)	28.6 KB	N/A
-- ├─Limit_30(Build)	10.00	10	cop[tikv]		time:1.04ms, loops:1, cop_task: {num: 2, max: 681µs, min: 313.2µs, avg: 497.1µs, p95: 681µs, max_proc_keys: 10, p95_proc_keys: 10, tot_proc: 130.9µs, tot_wait: 402.1µs, copr_cache_hit_ratio: 0.00, build_task_duration: 9.12µs, max_distsql_concurrency: 1}, rpc_info:{Cop:{num_rpc:2, total_time:976.7µs}}, tikv_task:{proc max:0s, min:0s, avg: 0s, p80:0s, p95:0s, iters:2, tasks:2}, scan_detail: {total_process_keys: 10, total_process_keys_size: 2420, total_keys: 12, get_snapshot_time: 368.8µs, rocksdb: {key_skipped_count: 11, block: {cache_hit_count: 10}}}, time_detail: {total_process_time: 130.9µs, total_wait_time: 402.1µs, tikv_wall_time: 673.2µs}	offset:0, count:10	N/A	N/A
-- │ └─IndexRangeScan_28	10.00	10	cop[tikv]	table:a, index:idx_articles_user_status_type_published_at_id(user_id, status, type, published_at, article_id)	tikv_task:{proc max:0s, min:0s, avg: 0s, p80:0s, p95:0s, iters:2, tasks:2}	range:["00000000-0000-0000-0000-000000000002" "published" "tech","00000000-0000-0000-0000-000000000002" "published" "tech"], keep order:true, desc	N/A	N/A
-- └─TableRowIDScan_29(Probe)	10.00	10	cop[tikv]	table:a	time:594µs, loops:2, cop_task: {num: 1, max: 553.2µs, proc_keys: 10, tot_proc: 300.8µs, tot_wait: 19.7µs, copr_cache_hit_ratio: 0.00, build_task_duration: 19.7µs, max_distsql_concurrency: 1, max_extra_concurrency: 1}, rpc_info:{Cop:{num_rpc:1, total_time:546.2µs}}, tikv_task:{time:0s, loops:1}, scan_detail: {total_process_keys: 10, total_process_keys_size: 83220, total_keys: 20, get_snapshot_time: 7.75µs, rocksdb: {key_skipped_count: 10, block: {cache_hit_count: 40}}}, time_detail: {total_process_time: 300.8µs, total_wait_time: 19.7µs, tikv_wall_time: 382.3µs}	keep order:false	N/A	N/A
 
-- C-4. インデックス状態の最終確認
SHOW INDEX FROM articles;

-- articles	0	PRIMARY	1	article_id	A	118				BTREE			YES		YES
-- articles	0	uq_articles_slug	1	slug	A	118				BTREE			YES		NO
-- articles	1	idx_articles_user_status_type_published_at_id	1	user_id	A	1				BTREE			YES		NO
-- articles	1	idx_articles_user_status_type_published_at_id	2	status	A	2				BTREE			YES		NO
-- articles	1	idx_articles_user_status_type_published_at_id	3	type	A	2			YES	BTREE			YES		NO
-- articles	1	idx_articles_user_status_type_published_at_id	4	published_at	A	85			YES	BTREE			YES		NO
-- articles	1	idx_articles_user_status_type_published_at_id	5	article_id	A	118				BTREE			YES		NO
