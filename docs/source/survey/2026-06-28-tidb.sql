explain SELECT
  a.article_id,
  a.title,
  a.slug,
  a.user_id,
  a.content,
  a.thumbnail,
  a.description,
  a.status,
  a.`type`,
  a.published_at,
  a.created_at,
  a.updated_at
FROM
  articles a
  JOIN users u ON a.user_id = u.user_id
WHERE
  a.status = 'published'
  AND a.`type` = 'tech'
  AND u.name = 'shuntaka'
ORDER BY
  a.published_at DESC;
  
SELECT
    LEADER_STORE_ID,
    COUNT(*) AS region_count,
    SUM(APPROXIMATE_KEYS) AS total_keys,
    SUM(APPROXIMATE_SIZE) AS total_size_mb
FROM INFORMATION_SCHEMA.TIKV_REGION_STATUS
WHERE DB_NAME = 'blog_prd' AND TABLE_NAME = 'articles'
GROUP BY LEADER_STORE_ID;

SELECT
  p.STORE_ID,
  COUNT(*)                  AS region_count,
  SUM(s.APPROXIMATE_KEYS)   AS total_keys,
  SUM(s.APPROXIMATE_SIZE)   AS total_size_mb
FROM INFORMATION_SCHEMA.TIKV_REGION_STATUS s
JOIN INFORMATION_SCHEMA.TIKV_REGION_PEERS  p
  ON s.REGION_ID = p.REGION_ID
WHERE s.DB_NAME = 'blog_prd'
  AND s.TABLE_NAME = 'articles'
  AND p.IS_LEADER = 1
GROUP BY p.STORE_ID
ORDER BY total_keys DESC;

-- +----------+--------------+------------+---------------+
-- | STORE_ID | region_count | total_keys | total_size_mb |
-- +----------+--------------+------------+---------------+
-- |        4 |            5 |          5 |            20 |
-- +----------+--------------+------------+---------------+
--1 row in set (0.01 sec)
--
-- ⚠ 注意: region_count=5 を「Region が 5 個」と読むのは誤り。
--   INFORMATION_SCHEMA.TIKV_REGION_STATUS は (region × インデックスキースペース)
--   ごとに 1 行返す。articles には [行データ + uq_articles_slug +
--   idx_articles_user_id + idx_articles_status_published_at + 内部メタ] の
--   5 キースペースがあり、物理 Region は 1 個 (REGION_ID=384) のみ。
--   後段の SHOW TABLE blog_prd.articles REGIONS で物理 Region 数が確認できる。

SELECT
  p.STORE_ID,
  SUM(p.IS_LEADER = 1) AS leader_cnt,
  SUM(p.IS_LEADER = 0) AS follower_cnt,
  COUNT(*)             AS peer_cnt
FROM INFORMATION_SCHEMA.TIKV_REGION_STATUS s
JOIN INFORMATION_SCHEMA.TIKV_REGION_PEERS  p
  ON s.REGION_ID = p.REGION_ID
WHERE s.DB_NAME = 'blog_prd'
  AND s.TABLE_NAME = 'articles'
GROUP BY p.STORE_ID
ORDER BY p.STORE_ID;

-- +----------+------------+--------------+----------+
-- | STORE_ID | leader_cnt | follower_cnt | peer_cnt |
-- +----------+------------+--------------+----------+
-- |        1 |          0 |            5 |        5 |
-- |        4 |          5 |            0 |        5 |
-- |        5 |          0 |            5 |        5 |
-- +----------+------------+--------------+----------+
-- 3 rows in set (0.01 sec)
--
-- ⚠ 同じく peer_cnt=5 / follower_cnt=5 / leader_cnt=5 は (region × keyspace)
--   多重化の結果で、実体は 1 物理 Region。
--   読み取るべきは「3 Store すべてに行が出ている = Region 384 の 3 Peer が
--   Store 1/4/5 に正しく分散している」「Leader (Store 4) と Follower (Store 1/5)
--   の役割が明確に分かれている」という構図。

SELECT
  STORE_ID,
  LEADER_COUNT,
  REGION_COUNT,
  LEADER_SCORE,
  REGION_SCORE
FROM INFORMATION_SCHEMA.TIKV_STORE_STATUS
ORDER BY STORE_ID;

-- +----------+--------------+--------------+--------------+--------------------+
-- | STORE_ID | LEADER_COUNT | REGION_COUNT | LEADER_SCORE | REGION_SCORE       |
-- +----------+--------------+--------------+--------------+--------------------+
-- |        1 |            3 |            6 |            3 | 15.832994492046943 |
-- |        4 |            3 |            6 |            3 | 15.826141336779038 |
-- |        5 |            0 |            6 |            0 | 15.827403321970076 |
-- +----------+--------------+--------------+--------------+--------------------+
-- 3 rows in set (0.01 sec)
--
-- 観察:
--   * クラスタ全体で物理 Region は 6 個（articles 1 + 他 5: users / tags /
--     articles_tags / システム表など）。各 Store が全 Region の Peer を保持
--   * REGION_SCORE はほぼ同値 (15.82〜15.83) = データ量はきれいに分散、冗長性 OK
--   * Leader 分布 (3/3/0)。Store 4 の 3 個のうち 1 個が articles の Region 384、
--     残りは他テーブル / システム表。
--   * 前段の articles 単独 (5/0/0) は keyspace 多重化のアーティファクト。
--     articles の Leader は最初から Store 4 に「1 個」だけ。PD が再配置した
--     形跡は無く、初期配置のまま。
--   * Store 5 だけ Leader 数 0 のまま → 次のクエリで原因を調査

-- ---------------------------------------------------------------------------
-- Store 5 に Leader が無い原因の特定: Store 詳細メトリクスと配置ルール
-- ---------------------------------------------------------------------------
SELECT STORE_ID, ADDRESS, STORE_STATE_NAME, LABEL,
       LEADER_WEIGHT, LEADER_SIZE, REGION_WEIGHT, UPTIME
FROM INFORMATION_SCHEMA.TIKV_STORE_STATUS
ORDER BY STORE_ID\G

-- *************************** 1. row ***************************
--         STORE_ID: 1
--          ADDRESS: basic-tikv-2.basic-tikv-peer.tidb-cluster.svc:20160
-- STORE_STATE_NAME: Up
--            LABEL: null
--    LEADER_WEIGHT: 1
--      LEADER_SIZE: 6
--    REGION_WEIGHT: 1
--           UPTIME: 5h8m52.818864498s
-- *************************** 2. row ***************************
--         STORE_ID: 4
--          ADDRESS: basic-tikv-1.basic-tikv-peer.tidb-cluster.svc:20160
-- STORE_STATE_NAME: Up
--            LABEL: null
--    LEADER_WEIGHT: 1
--      LEADER_SIZE: 6
--    REGION_WEIGHT: 1
--           UPTIME: 5h8m32.8394295s
-- *************************** 3. row ***************************
--         STORE_ID: 5
--          ADDRESS: basic-tikv-0.basic-tikv-peer.tidb-cluster.svc:20160
-- STORE_STATE_NAME: Up
--            LABEL: null
--    LEADER_WEIGHT: 1
--      LEADER_SIZE: 0
--    REGION_WEIGHT: 1
--           UPTIME: 5h7m32.260283592s
-- 3 rows in set (0.00 sec)

SHOW PLACEMENT;

-- Empty set (0.01 sec)

-- ---------------------------------------------------------------------------
-- わかったこと: Store 5 に Leader が無い理由
-- ---------------------------------------------------------------------------
-- 設定面の容疑をすべて潰した結果、Leader 不在は「設定」由来ではない:
--   x Placement rule で除外している?           -> SHOW PLACEMENT 空
--   x ラベルで配置制約?                         -> 全 Store LABEL: null
--   x LEADER_WEIGHT=0 で手動制御?              -> 全 Store LEADER_WEIGHT: 1
--   x Store の状態異常?                         -> 全 Store STORE_STATE_NAME: Up
--   o 起動順序による初期偏り                    -> Store 5 だけ ~1 分遅れて起動
--                                                  (UPTIME: 5h7m vs 5h8m)
--
-- 結論:
--   Store 5 の起動が遅れている間に Region 作成が走って Stores 1/4 に Leader が
--   確定。その後 PD は LEADER_SCORE 差 3 程度（3 vs 0）では再配置の旨味なしと
--   判断して放置。これは小規模クラスタにおける balance-leader-scheduler の
--   正常な収束結果で、設定ミスでもバグでもない。
--
--   Region 数が増えれば（自動分割が走るくらいデータが溜まれば）Score 差が
--   PD のトレラント閾値を超え、自然に Store 5 にも Leader が割り当てられる。
--   即時に均衡化したいなら:
--     pd-ctl operator add transfer-leader <region_id> 5

-- ---------------------------------------------------------------------------
-- articles の物理 Region を直接確認 (SHOW TABLE ... REGIONS)
-- ---------------------------------------------------------------------------
-- INFORMATION_SCHEMA.TIKV_REGION_STATUS は (region × インデックスキースペース) で
-- 行を多重化するため、Region の物理数を知るには SHOW TABLE REGIONS を使う。
SHOW TABLE blog_prd.articles REGIONS\G

-- *************************** 1. row ***************************
--              REGION_ID: 384
--              START_KEY: 72000001
--                END_KEY: t_281474976710654_
--              LEADER_ID: 386
--        LEADER_STORE_ID: 4
--                  PEERS: 385, 386, 387
--             SCATTERING: 0
--          WRITTEN_BYTES: 42
--             READ_BYTES: 245770
--   APPROXIMATE_SIZE(MB): 4
--       APPROXIMATE_KEYS: 1
-- SCHEDULING_CONSTRAINTS:
--       SCHEDULING_STATE:
-- 1 row in set (0.00 sec)

-- 念のため TIKV_REGION_STATUS で同じ REGION_ID が何回出てくるか確認
SELECT REGION_ID, START_KEY, END_KEY, APPROXIMATE_KEYS, APPROXIMATE_SIZE
FROM INFORMATION_SCHEMA.TIKV_REGION_STATUS
WHERE DB_NAME = 'blog_prd' AND TABLE_NAME = 'articles'\G

-- → 5 rows in set (0.01 sec)
-- すべて REGION_ID=384、START_KEY/END_KEY も同一。つまり 1 物理 Region を
-- 5 つのキースペース視点で 5 行に分解して返している。

SELECT COUNT(*) AS regions
FROM INFORMATION_SCHEMA.TIKV_REGION_STATUS
WHERE DB_NAME = 'blog_prd' AND TABLE_NAME = 'articles';
-- +---------+
-- | regions |
-- +---------+
-- |       5 |    ← keyspace 多重化込み
-- +---------+

-- 物理 Region 数を正しく取りたいなら DISTINCT が必要:
-- SELECT COUNT(DISTINCT REGION_ID) FROM INFORMATION_SCHEMA.TIKV_REGION_STATUS
-- WHERE DB_NAME = 'blog_prd' AND TABLE_NAME = 'articles';   -- => 1

-- ---------------------------------------------------------------------------
-- 5 行の正体を IS_INDEX / INDEX_NAME で列挙
-- ---------------------------------------------------------------------------
SELECT REGION_ID, IS_INDEX, INDEX_ID, INDEX_NAME
FROM INFORMATION_SCHEMA.TIKV_REGION_STATUS
WHERE DB_NAME = 'blog_prd' AND TABLE_NAME = 'articles';

-- +-----------+----------+----------+----------------------------------+
-- | REGION_ID | IS_INDEX | INDEX_ID | INDEX_NAME                       |
-- +-----------+----------+----------+----------------------------------+
-- |       384 |        1 |        1 | PRIMARY                          |
-- |       384 |        1 |        2 | uq_articles_slug                 |
-- |       384 |        1 |        3 | idx_articles_user_id             |
-- |       384 |        1 |        4 | idx_articles_status_published_at |
-- |       384 |        0 |     NULL | NULL                             |  ← 行データ本体
-- +-----------+----------+----------+----------------------------------+
-- 5 rows in set (0.01 sec)
--
-- 内訳:
--   * PRIMARY (IS_INDEX=1, INDEX_ID=1)
--       → clustered PK のため独立した keyspace は持たず、行データ (下) と
--         同じ物理ストレージを共有する。ビュー上は論理エントリとして 1 行返る。
--   * uq_articles_slug / idx_articles_user_id / idx_articles_status_published_at
--       → セカンダリインデックス。それぞれ独立した keyspace (t<id>_i<n>_...) を持つ。
--   * IS_INDEX=0, INDEX_NAME=NULL の行
--       → テーブルの行データ本体 (t<id>_r<clustered PK>)
--
-- つまり「5」の正体は:
--   行データ 1 + セカンダリインデックス 3 + 論理 PRIMARY エントリ 1
--   = 物理的には 4 keyspace 相当のデータ
--   = それらすべてが 1 物理 Region (REGION_ID=384) に収まっている
--   = TIKV_REGION_STATUS ビューが論理エントリごとに行を返すので 5 行に見える

-- ---------------------------------------------------------------------------
-- わかったこと: articles の物理 Region 数と「どのレコードがどの Region か」
-- ---------------------------------------------------------------------------
-- * articles の物理 Region は 1 個 (REGION_ID=384) のみ
-- * Leader は Store 4、Followers は Store 1 と Store 5
-- * 全 130 行が REGION_ID=384 のキー範囲 (hex 7200000100000000FB 〜
--   748000FFFFFFFFFFFFFE...) に収まっている
-- * APPROXIMATE_SIZE(MB)=4 で TiKV 自動分割閾値 (~96MB) に達していないため、
--   分割は走らず Region 数も増えない
-- * 「articles の Leader が Store 4 に集中」と前段で書いていたが、実体は
--   「Region が 1 個しか無いので Leader も 1 個、それが Store 4 にある」だけ
-- * 行ごとの Region 所属を引きたい将来 (複数 Region に分割された後) は、
--   SHOW TABLE REGIONS の START_KEY/END_KEY と PK を比較するか、
--   TIDB_DECODE_KEY() でキーをデコードする
