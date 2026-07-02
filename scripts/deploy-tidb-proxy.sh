#!/usr/bin/env bash
set -euo pipefail

REGION="${AWS_REGION:-ap-northeast-1}"
REPO_ROOT="$(git rev-parse --show-toplevel)"
ECSPRESSO_CONFIG="${REPO_ROOT}/iac/aws/ecspresso/tidb-proxy/ecspresso.jsonnet"
BUILD_CONTEXT="${REPO_ROOT}/apps/tidb-proxy"

IMAGE_TAG="${IMAGE_TAG:-$(git -C "$REPO_ROOT" rev-parse --short HEAD)}"

ECR_URI=$(aws ssm get-parameter \
  --region "$REGION" \
  --name /tidb-proxy/proxy/ecr-repository-uri \
  --query "Parameter.Value" --output text)

echo "==> region=${REGION} image=${ECR_URI}:${IMAGE_TAG}"

aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "${ECR_URI%/*}"

docker buildx build \
  --platform linux/arm64 \
  -t "${ECR_URI}:${IMAGE_TAG}" \
  --push \
  "$BUILD_CONTEXT"

IMAGE_TAG="$IMAGE_TAG" ecspresso deploy --config "$ECSPRESSO_CONFIG"
