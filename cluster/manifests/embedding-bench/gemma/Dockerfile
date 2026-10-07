# syntax=docker/dockerfile:1

# plamo-embedding と同じく CPU 版 PyTorch を linux/amd64 向けにインストールする。
# EmbeddingGemma 2 (model_type: embedding_gemma2) は transformers 5.19.0 で追加された。
# text だけ使う場合も Processor が Gemma 4 の画像処理を import するため torchvision と
# pillow が要る。
FROM python:3.13-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      libjemalloc2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN pip install --no-cache-dir \
      --index-url https://download.pytorch.org/whl/cpu \
      torch==2.14.1 \
      torchvision==0.29.1 \
    && pip install --no-cache-dir \
      transformers==5.19.0 \
      sentence-transformers==6.1.0 \
      pillow==12.3.0 \
      fastapi==0.115.4 \
      uvicorn==0.32.0 \
      pydantic==2.9.2

COPY server.py /app/

# モデルファイル (~1.5GB, vision / audio encoder 込みの bf16 safetensors) を
# ビルド時に image へ焼き込む。理由は ../../plamo-embedding/Dockerfile を参照。
ARG MODEL_ID=google/embeddinggemma-2
ENV MODEL_ID=${MODEL_ID}
RUN python -c "from huggingface_hub import snapshot_download; \
  snapshot_download(repo_id='${MODEL_ID}')"

# plamo-embedding と条件を揃えるため jemalloc を使う。
ENV LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libjemalloc.so.2
ENV MALLOC_CONF=background_thread:true,dirty_decay_ms:10000

EXPOSE 8080
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080"]
