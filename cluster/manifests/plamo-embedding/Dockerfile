# syntax=docker/dockerfile:1

# CPU 版 PyTorch を linux/amd64 向けにインストール (MiniPC cluster は Ryzen 7 7730U)。
# amd64 wheel は https://download.pytorch.org/whl/cpu に登録済み。
# python 3.14 は torch 2.5.1 の cp314 wheel が存在せずビルド不能 (renovate.json で <3.14 に制限)。
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      libjemalloc2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN pip install --no-cache-dir \
      --index-url https://download.pytorch.org/whl/cpu \
      torch==2.5.1 \
    && pip install --no-cache-dir \
      transformers==4.46.0 \
      sentencepiece==0.2.0 \
      fastapi==0.115.4 \
      uvicorn==0.32.0 \
      pydantic==2.9.2

COPY server.py chunking.py /app/

# ビルド時にモデルファイルを事前ダウンロードし image に焼き込む (~2.3GB)。
# AutoModel.from_pretrained() を使うと RAM に model を全展開して verify する
# ため Docker Desktop 既定メモリ (2-4GB) を超えて OOM になる。snapshot_download は
# ファイル取得だけで RAM を使わない (transformers の transitive dep なので追加
# install 不要)。runtime の server.py は HF cache から load するので network 不要。
ARG MODEL_ID=pfnet/plamo-embedding-1b
ENV MODEL_ID=${MODEL_ID}
RUN python -c "from huggingface_hub import snapshot_download; \
  snapshot_download(repo_id='${MODEL_ID}')"

# glibc malloc は同時推論で確保したアクティベーションの free 済みヒープを OS へ
# 返さず、backfill 後もアイドル RSS がピーク近くに張り付く (uvicorn の threadpool
# が arena を分散させるのと、大きめ確保で mmap 閾値が動的に引き上がるため)。
# jemalloc に差し替え、background_thread でアイドル中も dirty page を purge して
# 投入完了後にメモリ水準が戻るようにする。パスは amd64 固定ビルド前提
# (build-and-push.sh 参照)。
ENV LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libjemalloc.so.2
ENV MALLOC_CONF=background_thread:true,dirty_decay_ms:10000

EXPOSE 8080
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080"]
