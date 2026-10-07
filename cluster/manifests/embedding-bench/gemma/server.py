# cspell:ignore healthz embeddinggemma
"""EmbeddingGemma 2 の HTTP wrapper (PLaMo とのベンチマーク用).

plamo-embedding と同じ `POST /embed` 契約 ({"text": "...", "mode": "query"|"document"})
で 768 次元の正規化済み float 配列を返す。tools/embedding-bench から両モデルを
同じクライアントで叩けるようにするため、リクエスト / レスポンス形は揃えている。
"""

import logging
import os

import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

MODEL_ID = os.environ.get("MODEL_ID", "google/embeddinggemma-2")

log.info("loading model=%s", MODEL_ID)
# CPU は bfloat16 の native 演算がないため float32 で動かす (float16 は NaN になるので使わない)。
# vision / audio encoder を外して text model (270M) だけを載せる。
model = SentenceTransformer(
    MODEL_ID,
    device="cpu",
    model_kwargs={"torch_dtype": torch.float32},
    config_kwargs={"vision_config": None, "audio_config": None},
)
log.info("model loaded")

app = FastAPI()


class EmbedRequest(BaseModel):
    text: str
    mode: str  # "query" | "document"
    title: str | None = None


class EmbedResponse(BaseModel):
    vector: list[float]
    dim: int


@app.post("/embed", response_model=EmbedResponse)
def embed(req: EmbedRequest) -> EmbedResponse:
    if req.mode == "query":
        text = f"task: search result | query: {req.text}"
    elif req.mode == "document":
        text = f"title: {req.title or 'none'} | text: {req.text}"
    else:
        raise HTTPException(status_code=400, detail="mode must be 'query' or 'document'")
    with torch.inference_mode():
        vec = model.encode(text, normalize_embeddings=True, convert_to_numpy=True)
    vec_list = vec.astype("float32").tolist()
    return EmbedResponse(vector=vec_list, dim=len(vec_list))


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}
