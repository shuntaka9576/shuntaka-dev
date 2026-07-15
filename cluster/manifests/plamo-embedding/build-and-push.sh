#!/usr/bin/env bash
# PLaMo Embedding image を linux/arm64 でビルドして ghcr に push する。
#
# 前提:
#   - `docker login ghcr.io` 済み (write:packages スコープ付きの PAT が必要)
#   - Apple Silicon Mac から実行 (native arm64 なのでビルド速い。x86_64 からは
#     buildx の QEMU emulation でも動くが、torch install が遅い)
#
# Usage:
#   ./build-and-push.sh                 # ghcr.io/shuntaka9576/plamo-embedding:latest を push
#   TAG=2026-07-15 ./build-and-push.sh  # 別タグを付与
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

IMAGE="${IMAGE:-ghcr.io/shuntaka9576/plamo-embedding}"
TAG="${TAG:-latest}"

echo "==> Building ${IMAGE}:${TAG} (linux/arm64)"
# --provenance=false / --sbom=false: buildx はデフォルトで OCI index に attestation
# manifest を追加するが、k3s/MiniPC の古めの containerd がそれで "no match for
# platform" と誤判定して pull に失敗する。attestation を切ると single-platform
# の manifest だけになり pull が通る。
docker buildx build \
  --platform linux/arm64 \
  --provenance=false \
  --sbom=false \
  -t "${IMAGE}:${TAG}" \
  --push \
  .

echo
echo "Done. To rollout on cluster:"
echo "  kubectl -n plamo-embedding rollout restart deployment/plamo-embedding"
