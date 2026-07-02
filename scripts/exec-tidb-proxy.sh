#!/usr/bin/env bash
set -euo pipefail

REGION="${AWS_REGION:-ap-northeast-1}"
CLUSTER="${CLUSTER:-tidb-proxy}"
SERVICE="${SERVICE:-tidb-proxy}"
CONTAINER="${CONTAINER:-tidb-proxy}"
COMMAND="${1:-/bin/sh}"

TASK_ARN=$(aws ecs list-tasks \
  --region "$REGION" \
  --cluster "$CLUSTER" \
  --service-name "$SERVICE" \
  --desired-status RUNNING \
  --query "taskArns[0]" \
  --output text)

if [[ -z "$TASK_ARN" || "$TASK_ARN" == "None" ]]; then
  echo "no running task on cluster=${CLUSTER} service=${SERVICE}" >&2
  exit 1
fi

echo "==> task=${TASK_ARN##*/} command=${COMMAND}"

exec aws ecs execute-command \
  --region "$REGION" \
  --cluster "$CLUSTER" \
  --task "$TASK_ARN" \
  --container "$CONTAINER" \
  --command "$COMMAND" \
  --interactive
