#!/usr/bin/env bash

set -euo pipefail

readonly ATHENA_REGION="${AWS_REGION:-ap-northeast-1}"
readonly ATHENA_DATABASE="tidb_proxy_logs"
readonly ATHENA_WORK_GROUP="tidb-proxy-logs"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPOSITORY_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
readonly REPOSITORY_ROOT
readonly SQL_DIRECTORY="${REPOSITORY_ROOT}/iac/aws/sql/tidb-proxy-logs"

for required_command in aws jq; do
  if ! command -v "${required_command}" >/dev/null 2>&1; then
    echo "required command not found: ${required_command}" >&2
    exit 1
  fi
done

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
readonly ACCOUNT_ID
readonly BUCKET="tidb-proxy-logs-${ACCOUNT_ID}"

summarize_prefix() {
  local prefix="$1"

  aws s3api list-objects-v2 \
    --bucket "${BUCKET}" \
    --prefix "${prefix}" \
    --query '{Objects:length(Contents),Bytes:sum(Contents[].Size)}' \
    --output json
}

show_metadata_state() {
  local metadata_uri

  metadata_uri="$(
    aws glue get-table \
      --database-name "${ATHENA_DATABASE}" \
      --name logs \
      --region "${ATHENA_REGION}" \
      --query 'Table.Parameters.metadata_location' \
      --output text
  )"

  echo "metadata_location=${metadata_uri}"
  aws s3 cp "${metadata_uri}" - --no-progress |
    jq '{
      snapshots: (.snapshots | length),
      snapshot_log: (."snapshot-log" | length),
      metadata_log: (."metadata-log" | length),
      last_updated_ms: ."last-updated-ms"
    }'
}

run_athena_query() {
  local label="$1"
  local sql_file="$2"
  local query_id
  local execution
  local state

  echo
  echo "== ${label} =="
  query_id="$(
    aws athena start-query-execution \
      --region "${ATHENA_REGION}" \
      --work-group "${ATHENA_WORK_GROUP}" \
      --query-execution-context "Database=${ATHENA_DATABASE}" \
      --query-string "$(<"${sql_file}")" \
      --query QueryExecutionId \
      --output text
  )"
  echo "query_execution_id=${query_id}"

  while true; do
    execution="$(
      aws athena get-query-execution \
        --region "${ATHENA_REGION}" \
        --query-execution-id "${query_id}" \
        --output json
    )"
    state="$(jq -r '.QueryExecution.Status.State' <<<"${execution}")"
    echo "state=${state}"

    case "${state}" in
      SUCCEEDED)
        break
        ;;
      FAILED | CANCELLED)
        jq -r '.QueryExecution.Status.StateChangeReason // "no failure reason"' <<<"${execution}" >&2
        return 1
        ;;
      *)
        sleep 2
        ;;
    esac
  done

  jq '{
    query_execution_id: .QueryExecution.QueryExecutionId,
    state: .QueryExecution.Status.State,
    submission_datetime: .QueryExecution.Status.SubmissionDateTime,
    completion_datetime: .QueryExecution.Status.CompletionDateTime,
    engine_execution_ms: .QueryExecution.Statistics.EngineExecutionTimeInMillis,
    data_scanned_bytes: .QueryExecution.Statistics.DataScannedInBytes,
    output_location: .QueryExecution.ResultConfiguration.OutputLocation
  }' <<<"${execution}"
}

echo "== Target =="
echo "account_id=${ACCOUNT_ID}"
echo "region=${ATHENA_REGION}"
echo "work_group=${ATHENA_WORK_GROUP}"
echo "database=${ATHENA_DATABASE}"
echo "bucket=${BUCKET}"

echo
echo "== Before: data =="
summarize_prefix iceberg/logs/data/
echo "== Before: metadata =="
summarize_prefix iceberg/logs/metadata/
echo "== Before: current metadata =="
show_metadata_state

run_athena_query \
  "Apply 14-day snapshot retention" \
  "${SQL_DIRECTORY}/001-set-vacuum-retention-14d.sql"
run_athena_query \
  "Vacuum Iceberg table" \
  "${SQL_DIRECTORY}/vacuum.sql"

echo
echo "== After: data =="
summarize_prefix iceberg/logs/data/
echo "== After: metadata =="
summarize_prefix iceberg/logs/metadata/
echo "== After: current metadata =="
show_metadata_state
