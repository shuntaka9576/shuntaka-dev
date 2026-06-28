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




