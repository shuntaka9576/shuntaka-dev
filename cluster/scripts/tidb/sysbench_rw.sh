#!/usr/bin/env bash
# sysbench OLTP read-write mix against TiDB. Run from a cluster node hitting NodePort.
set -euo pipefail

HOST=${TIDB_HOST:-127.0.0.1}
PORT=${TIDB_PORT:-4000}
USER=${TIDB_USER:-root}
PASS=${TIDB_PASS:-}
DB=${TIDB_DB:-sbtest}
TABLES=${TABLES:-4}
SIZE=${SIZE:-250000}
TIME=${TIME:-30}
THREADS_LIST=${THREADS_LIST:-"32 64 128 256"}
TEST=${TEST:-oltp_read_write}   # oltp_read_write | oltp_write_only | oltp_update_index

CMN=(
  --db-driver=mysql
  --mysql-host="$HOST"
  --mysql-port="$PORT"
  --mysql-user="$USER"
  --mysql-db="$DB"
  --mysql-ssl=off
)
[[ -n "$PASS" ]] && CMN+=(--mysql-password="$PASS")

echo "== prepare ($TEST, tables=$TABLES, rows/table=$SIZE) =="
mysql -h "$HOST" -P "$PORT" -u "$USER" --protocol=TCP -e "CREATE DATABASE IF NOT EXISTS ${DB};"
sysbench "$TEST" "${CMN[@]}" --tables="$TABLES" --table-size="$SIZE" prepare

for t in $THREADS_LIST; do
  echo
  echo "== $TEST  threads=${t}  time=${TIME}s =="
  sysbench "$TEST" "${CMN[@]}" \
    --tables="$TABLES" --table-size="$SIZE" \
    --threads="$t" --time="$TIME" --report-interval=10 \
    run | tee /tmp/_sb_rw_out
  awk '/queries:|transactions:|95th percentile/ {print "  -> " $0}' /tmp/_sb_rw_out
done

echo
echo "== cleanup =="
sysbench "$TEST" "${CMN[@]}" --tables="$TABLES" --table-size="$SIZE" cleanup
echo "done."
