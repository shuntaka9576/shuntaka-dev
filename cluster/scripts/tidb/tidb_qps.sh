#!/usr/bin/env bash
set -euo pipefail

HOST=${TIDB_HOST:-127.0.0.1}
PORT=${TIDB_PORT:-4000}
USER=${TIDB_USER:-root}
DB=${TIDB_DB:-bench}

slap() {
  local label=$1 conc=$2 nq=$3 sql=$4
  echo
  echo "== ${label}  concurrency=${conc}  queries=${nq} =="
  mysqlslap -h "$HOST" -P "$PORT" -u "$USER" --protocol=TCP \
    --create-schema="$DB" \
    --no-drop \
    --concurrency="$conc" \
    --iterations=1 \
    --number-of-queries="$nq" \
    --query="$sql" \
  | tee /tmp/_slap_out
  # mysqlslap reports avg time; QPS = nq / avg_seconds
  local secs
  secs=$(awk '/Average number of seconds to run all queries/ {print $(NF-1)}' /tmp/_slap_out)
  if [[ -n "${secs:-}" ]]; then
    awk -v n="$nq" -v s="$secs" 'BEGIN { printf "  -> QPS = %.0f\n", n/s }'
  fi
}

# 1. point SELECT by PK
SQL_PK="SELECT * FROM load_test WHERE id = FLOOR(RAND()*1000000)+1"
for c in 1 16 64 128; do
  slap "point SELECT (PK)" "$c" 5000 "$SQL_PK"
done

# 2. point SELECT by secondary index (k)
SQL_K="SELECT id,v FROM load_test WHERE k = FLOOR(RAND()*100000) LIMIT 10"
for c in 16 64 128; do
  slap "indexed SELECT (k)" "$c" 5000 "$SQL_K"
done

# 3. UPDATE by PK
SQL_UPD="UPDATE load_test SET v = MD5(RAND()) WHERE id = FLOOR(RAND()*1000000)+1"
for c in 16 64; do
  slap "point UPDATE (PK)" "$c" 3000 "$SQL_UPD"
done

# 4. INSERT
SQL_INS="INSERT INTO load_test (k,v,pad) VALUES (FLOOR(RAND()*100000), MD5(RAND()), REPEAT('x',128))"
for c in 16 64; do
  slap "INSERT" "$c" 3000 "$SQL_INS"
done

echo
echo "all benchmarks done."
