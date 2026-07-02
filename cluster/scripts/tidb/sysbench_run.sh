#!/usr/bin/env bash
# Run sysbench OLTP point-select against TiDB, time-bounded.
# Sweep concurrency to find the point we cross ~10k QPS.
set -euo pipefail

HOST=${TIDB_HOST:-127.0.0.1}
PORT=${TIDB_PORT:-4000}
USER=${TIDB_USER:-root}
PASS=${TIDB_PASS:-}
DB=${TIDB_DB:-sbtest}
TABLES=${TABLES:-4}
SIZE=${SIZE:-250000}        # rows per table
TIME=${TIME:-20}            # seconds per run
THREADS_LIST=${THREADS_LIST:-"32 64 128 256"}

CMN=(
  --db-driver=mysql
  --mysql-host="$HOST"
  --mysql-port="$PORT"
  --mysql-user="$USER"
  --mysql-db="$DB"
  --mysql-ssl=off
)
[[ -n "$PASS" ]] && CMN+=(--mysql-password="$PASS")

echo "== prepare =="
mysql -h "$HOST" -P "$PORT" -u "$USER" --protocol=TCP -e "CREATE DATABASE IF NOT EXISTS ${DB};"
sysbench oltp_point_select "${CMN[@]}" --tables="$TABLES" --table-size="$SIZE" prepare

for t in $THREADS_LIST; do
  echo
  echo "== oltp_point_select  threads=${t}  time=${TIME}s =="
  sysbench oltp_point_select "${CMN[@]}" \
    --tables="$TABLES" --table-size="$SIZE" \
    --threads="$t" --time="$TIME" --report-interval=5 \
    run | tee /tmp/_sb_out
  awk '/queries:/ && /per sec/ {print "  -> " $0}' /tmp/_sb_out || true
done

echo
echo "== cleanup =="
sysbench oltp_point_select "${CMN[@]}" --tables="$TABLES" --table-size="$SIZE" cleanup
echo "done."
