#!/usr/bin/env bash
# Push TiDB toward a target QPS by sweeping high concurrency on a point lookup.
# Designed to be run on a cluster node hitting NodePort directly (low RTT).
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
  local secs
  secs=$(awk '/Average number of seconds to run all queries/ {print $(NF-1)}' /tmp/_slap_out)
  if [[ -n "${secs:-}" ]]; then
    awk -v n="$nq" -v s="$secs" 'BEGIN { printf "  -> QPS = %.0f  (%.3fs)\n", n/s, s }'
  fi
}

SQL_PK="SELECT * FROM load_test WHERE id = FLOOR(RAND()*1000000)+1"
SQL_K="SELECT id,v FROM load_test WHERE k = FLOOR(RAND()*100000) LIMIT 10"

# Sweep concurrency aiming for >= 10k QPS on point SELECT by PK
for c in 64 128 256 512; do
  slap "point SELECT (PK)" "$c" 200000 "$SQL_PK"
done

# Same sweep for indexed lookup
for c in 128 256 512; do
  slap "indexed SELECT (k)" "$c" 200000 "$SQL_K"
done

echo
echo "done."
