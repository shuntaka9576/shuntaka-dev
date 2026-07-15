#!/usr/bin/env bash
# PLaMo Embedding image を linux/amd64 でビルドして ghcr に push する。
# MiniPC cluster の node は Intel NUC 系 (amd64) のため amd64 target。
# Apple Silicon Mac から実行する場合は buildx が QEMU emulation を挟むので
# 初回 build は arm64 native よりも遅い (torch install が特に重い)。
#
# 前提:
#   - ghcr にログイン済み (Phase 2-4 参照)
#   - Rancher Desktop / Docker Desktop で QEMU emulation が有効
#     (未設定なら: `docker run --privileged --rm tonistiigi/binfmt --install all`)
#
# Usage:
#   ./build-and-push.sh                 # ghcr.io/shuntaka9576/plamo-embedding:latest を push
#   TAG=2026-07-15 ./build-and-push.sh  # 別タグを付与
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

IMAGE="${IMAGE:-ghcr.io/shuntaka9576/plamo-embedding}"
TAG="${TAG:-latest}"

echo "==> Building ${IMAGE}:${TAG} (linux/amd64)"
# --provenance=false / --sbom=false: buildx はデフォルトで OCI index に attestation
# manifest を追加するが、cluster 側 containerd がそれで "no match for platform"
# と誤判定して pull に失敗する。attestation を切ると single-platform manifest
# だけになり pull が通る。
docker buildx build \
  --platform linux/amd64 \
  --provenance=false \
  --sbom=false \
  -t "${IMAGE}:${TAG}" \
  --push \
  .

echo
echo "Done. To rollout on cluster:"
echo "  kubectl -n plamo-embedding rollout restart deployment/plamo-embedding"
