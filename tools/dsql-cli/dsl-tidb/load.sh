#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: load.sh [options]

Apply DDL (schema/*.sql) and LOAD DATA LOCAL INFILE (load/*.sql) to a TiDB
cluster. ${SCHEMA} placeholders are replaced with --database, ${TSV} with the
TSV file path. SHOW WARNINGS runs in the same session as each LOAD DATA so the
mysql client surfaces any conversion warnings.

Required:
  -d, --database <name>      Target TiDB database name (e.g. blog_dev, blog_prod)

Connection (defaults to env then sane fallback):
  -H, --host <host>          TiDB host       (default: $TIDB_HOST or 127.0.0.1)
  -P, --port <port>          TiDB port       (default: $TIDB_PORT or 4000)
  -u, --user <user>          TiDB user       (default: $TIDB_USER or root)
  -p, --password <password>  TiDB password   (default: $TIDB_PASSWORD or empty)

Data:
  -t, --tsv-dir <dir>        TSV input dir   (default: $TSV_DIR or ./backup)
  -s, --source-schema <name> Source schema prefix in TSV filename (default: app)
                             (TSV path resolves to <tsv-dir>/<source-schema>.<table>.tsv)

Other:
  -h, --help                 Show this help
EOF
}

HOST="${TIDB_HOST:-127.0.0.1}"
PORT="${TIDB_PORT:-4000}"
USER="${TIDB_USER:-root}"
PASSWORD="${TIDB_PASSWORD-}"
DATABASE="${TIDB_DATABASE:-}"
TSV_DIR="${TSV_DIR:-./backup}"
SOURCE_SCHEMA="app"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -H|--host)          HOST="$2"; shift 2 ;;
    -P|--port)          PORT="$2"; shift 2 ;;
    -u|--user)          USER="$2"; shift 2 ;;
    -p|--password)      PASSWORD="$2"; shift 2 ;;
    -d|--database)      DATABASE="$2"; shift 2 ;;
    -t|--tsv-dir)       TSV_DIR="$2"; shift 2 ;;
    -s|--source-schema) SOURCE_SCHEMA="$2"; shift 2 ;;
    -h|--help)          usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ -z "${DATABASE}" ]]; then
  echo "Error: --database is required" >&2
  usage
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCHEMA_DIR="${SCRIPT_DIR}/schema"
LOAD_DIR="${SCRIPT_DIR}/load"

if [[ ! -d "${SCHEMA_DIR}" ]] || [[ ! -d "${LOAD_DIR}" ]]; then
  echo "Error: missing ${SCHEMA_DIR} or ${LOAD_DIR}" >&2
  exit 1
fi

if [[ ! -d "${TSV_DIR}" ]]; then
  echo "Error: TSV dir not found: ${TSV_DIR}" >&2
  exit 1
fi
TSV_ABS_DIR="$(cd "${TSV_DIR}" && pwd)"

MYSQL=(
  mysql
  -h "${HOST}"
  -P "${PORT}"
  -u "${USER}"
  --default-character-set=utf8mb4
  --local-infile=1
)
# Each load/*.sql ends with `SHOW WARNINGS;` so warnings are surfaced per LOAD DATA
# within the same session. We deliberately avoid mysql --show-warnings to keep the
# output free of an extra implicit warning-fetch after every statement.
# Pass password via env to avoid leaking via argv.
if [[ -n "${PASSWORD}" ]]; then
  export MYSQL_PWD="${PASSWORD}"
fi

apply_template() {
  local tsv="${1:-}"
  local file="$2"
  sed -e "s|\${SCHEMA}|${DATABASE}|g" -e "s|\${TSV}|${tsv}|g" "${file}" \
    | "${MYSQL[@]}"
}

echo "==> Applying DDL to \`${DATABASE}\` on ${HOST}:${PORT}"
for f in "${SCHEMA_DIR}"/*.sql; do
  [[ -e "${f}" ]] || continue
  echo "  apply $(basename "${f}")"
  apply_template "" "${f}"
done

echo
echo "==> LOAD DATA (TSV dir: ${TSV_ABS_DIR}, source schema: ${SOURCE_SCHEMA})"
for f in "${LOAD_DIR}"/*.sql; do
  [[ -e "${f}" ]] || continue
  base="$(basename "${f}" .sql)"
  table="${base#*_}"
  tsv="${TSV_ABS_DIR}/${SOURCE_SCHEMA}.${table}.tsv"
  if [[ ! -f "${tsv}" ]]; then
    echo "  [SKIP] ${tsv} not found" >&2
    continue
  fi
  echo "  load ${table} <- ${tsv}"
  apply_template "${tsv}" "${f}"
done

echo
echo "==> Row count verification"
for f in "${LOAD_DIR}"/*.sql; do
  [[ -e "${f}" ]] || continue
  base="$(basename "${f}" .sql)"
  table="${base#*_}"
  printf '  %-30s ' "${DATABASE}.${table}"
  "${MYSQL[@]}" -N -B -e "SELECT COUNT(*) FROM \`${DATABASE}\`.\`${table}\`"
done

echo
echo "Done."
