#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: dump-tidb.sh [options]

mysqldump a TiDB database over Tailscale into <out-dir>/<database>-<timestamp>.sql.

Required:
  -d, --database <name>      Target TiDB database name (e.g. blog_dev, blog_prd)

Connection (defaults to env then sane fallback):
  -H, --host <host>          TiDB host     (default: $TIDB_HOST or tidb.<tailnet MagicDNS suffix>)
  -P, --port <port>          TiDB port     (default: $TIDB_PORT or 4000)
  -u, --user <user>          TiDB user     (default: $TIDB_USER or root)
  -p, --password <password>  TiDB password (default: $TIDB_PASSWORD or empty)

Output:
  -o, --out-dir <dir>        Output dir    (default: $DUMP_OUT_DIR or <repo-root>/backup)

Other:
  -h, --help                 Show this help
EOF
}

HOST="${TIDB_HOST-}"
PORT="${TIDB_PORT:-4000}"
USER="${TIDB_USER:-root}"
PASSWORD="${TIDB_PASSWORD-}"
DATABASE=""
OUT_DIR="${DUMP_OUT_DIR-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -H|--host)     HOST="$2"; shift 2 ;;
    -P|--port)     PORT="$2"; shift 2 ;;
    -u|--user)     USER="$2"; shift 2 ;;
    -p|--password) PASSWORD="$2"; shift 2 ;;
    -d|--database) DATABASE="$2"; shift 2 ;;
    -o|--out-dir)  OUT_DIR="$2"; shift 2 ;;
    -h|--help)     usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ -z "${DATABASE}" ]]; then
  echo "Error: --database is required" >&2
  usage
  exit 1
fi

if [[ -z "${HOST}" ]]; then
  TAILNET=$(tailscale status --json | jq -r '.MagicDNSSuffix')
  HOST="tidb.${TAILNET}"
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
OUT_DIR="${OUT_DIR:-${REPO_ROOT}/backup}"
mkdir -p "${OUT_DIR}"

OUT_FILE="${OUT_DIR}/${DATABASE}-$(date +%Y%m%d-%H%M%S).sql"

# Pass password via env to avoid leaking via argv.
if [[ -n "${PASSWORD}" ]]; then
  export MYSQL_PWD="${PASSWORD}"
fi

echo "==> Dumping \`${DATABASE}\` from ${HOST}:${PORT} to ${OUT_FILE}"

# TiDB (v8.1) は mysqldump 8.x が --single-transaction 時に発行する
# ROLLBACK TO SAVEPOINT と非互換 (ERROR 1305) のため、--skip-lock-tables 方式で
# ダンプする。テーブル間の完全な一貫性は保証されないが、書き込み頻度の低い
# ブログ DB では実用上問題ない。厳密なスナップショットが必要な規模になったら
# Dumpling / BR に移行する。
# DB 名は --databases ではなく位置引数で渡す。--databases だと CREATE DATABASE /
# USE がダンプに埋め込まれ、別スキーマ（blog_prd → blog_dev 等）へのリストアが
# できなくなるため。リストアは mysql -D <対象DB> < dump で行う。
mysqldump -h "${HOST}" -P "${PORT}" -u "${USER}" \
  --skip-lock-tables --skip-add-locks --no-tablespaces --set-gtid-purged=OFF \
  "${DATABASE}" \
  > "${OUT_FILE}"

if ! tail -1 "${OUT_FILE}" | grep -q "^-- Dump completed"; then
  echo "Error: dump seems incomplete (no '-- Dump completed' footer): ${OUT_FILE}" >&2
  exit 1
fi

# 最新ダンプへの安定パス。リストア手順で `ls -t` 等のシェル依存の
# ファイル解決をしなくて済むようにする（ls が eza 等に alias されている
# 環境で $(ls -t ...) が壊れる事故があった）。
ln -sf "$(basename "${OUT_FILE}")" "${OUT_DIR}/${DATABASE}-latest.sql"

echo
echo "==> Row count verification"
MYSQL=(mysql -h "${HOST}" -P "${PORT}" -u "${USER}" --default-character-set=utf8mb4)
"${MYSQL[@]}" -N -B -e "
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = '${DATABASE}' ORDER BY table_name" \
| while read -r table; do
    printf '  %-30s ' "${DATABASE}.${table}"
    "${MYSQL[@]}" -N -B -e "SELECT COUNT(*) FROM \`${DATABASE}\`.\`${table}\`"
  done

echo
ls -lh "${OUT_FILE}"
echo "Done."
