#!/usr/bin/env bash
# EmbeddingGemma 2 bench image を linux/amd64 でビルドして ghcr に push する。
# 前提やフラグの理由は plamo-embedding/build-and-push.sh と同じ。
#
# Usage:
#   ./build-and-push.sh                 # ghcr.io/shuntaka9576/embeddinggemma-bench:2026-10-07 を push
#   TAG=2026-10-08 ./build-and-push.sh  # 別タグで push する (gemma.yaml の image も合わせて変える)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

IMAGE="${IMAGE:-ghcr.io/shuntaka9576/embeddinggemma-bench}"
# gemma.yaml は日付タグを参照する。latest は使わない (bench の再現性のため)。
TAG="${TAG:-2026-10-07}"

echo "==> Building ${IMAGE}:${TAG} (linux/amd64)"
docker buildx build \
  --platform linux/amd64 \
  --provenance=false \
  --sbom=false \
  -t "${IMAGE}:${TAG}" \
  --push \
  .

echo
echo "Done. To deploy on cluster:"
echo "  kubectl apply -f cluster/manifests/embedding-bench/gemma.yaml"
