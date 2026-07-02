#!/usr/bin/env bash
set -euo pipefail

HOST=${TIDB_HOST:-127.0.0.1}
PORT=${TIDB_PORT:-4000}
USER=${TIDB_USER:-root}
DB=${TIDB_DB:-bench}

mysql_run() {
  mysql -h "$HOST" -P "$PORT" -u "$USER" --protocol=TCP "$@"
}

echo "== schema =="
mysql_run -e "
CREATE DATABASE IF NOT EXISTS ${DB};
USE ${DB};
DROP TABLE IF EXISTS load_test;
CREATE TABLE load_test (
  id   BIGINT AUTO_INCREMENT PRIMARY KEY,
  k    INT NOT NULL,
  v    VARCHAR(255) NOT NULL,
  pad  VARCHAR(255) NOT NULL,
  ts   DATETIME DEFAULT CURRENT_TIMESTAMP,
  KEY idx_k (k)
);
"

ROWS_PER_BATCH=20000
BATCHES=50  # => 1,000,000 rows
echo "== insert ${BATCHES} batches x ${ROWS_PER_BATCH} rows =="
for i in $(seq 1 "$BATCHES"); do
  mysql_run "$DB" -e "
    INSERT INTO load_test (k, v, pad)
    SELECT FLOOR(RAND()*100000),
           MD5(RAND()),
           REPEAT(SUBSTRING(MD5(RAND()),1,16), 8)
      FROM information_schema.columns a
      JOIN information_schema.columns b
     LIMIT ${ROWS_PER_BATCH};
  "
  printf "batch %d/%d  total=%d\n" "$i" "$BATCHES" "$((i*ROWS_PER_BATCH))"
done

echo
echo "== row count =="
mysql_run "$DB" -e "SELECT COUNT(*) AS rows_total FROM load_test;"

echo
echo "== heavy queries =="

echo "-- Q1: full table groupby"
time mysql_run "$DB" -e "
  SELECT k, COUNT(*) AS c, AVG(LENGTH(v)) AS avg_v
    FROM load_test
   GROUP BY k
   ORDER BY c DESC
   LIMIT 20;
"

echo "-- Q2: self join on k (large intermediate)"
time mysql_run "$DB" -e "
  SELECT a.k, COUNT(*) AS pairs
    FROM load_test a
    JOIN load_test b ON a.k = b.k
   WHERE a.id < b.id
   GROUP BY a.k
   ORDER BY pairs DESC
   LIMIT 10;
"

echo "-- Q3: regex / no index scan"
time mysql_run "$DB" -e "
  SELECT COUNT(*) AS hex_match
    FROM load_test
   WHERE v REGEXP '^[a-f0-9]{32}$' AND pad LIKE '%abc%';
"

echo "-- Q4: window-ish ranking via correlated subquery"
time mysql_run "$DB" -e "
  SELECT k, cnt, RANK() OVER (ORDER BY cnt DESC) AS rk
    FROM (SELECT k, COUNT(*) AS cnt FROM load_test GROUP BY k) t
   LIMIT 50;
"

echo
echo "done."
