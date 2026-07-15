"""PLaMo Embedding 1B の HTTP wrapper.

`POST /embed` に {"text": "...", "mode": "query"|"document"} を投げると、
2048 次元の float 配列を返す。tidb-embedder (backfill) と blog-api (検索) が
同じ endpoint を叩く。
"""
import logging
import os

import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from transformers import AutoModel, AutoTokenizer

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

MODEL_ID = os.environ.get("MODEL_ID", "pfnet/plamo-embedding-1b")
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

log.info("loading model=%s device=%s", MODEL_ID, DEVICE)
tokenizer = AutoTokenizer.from_pretrained(MODEL_ID, trust_remote_code=True)
model = AutoModel.from_pretrained(MODEL_ID, trust_remote_code=True).to(DEVICE).eval()
log.info("model loaded")

app = FastAPI()


class EmbedRequest(BaseModel):
    text: str
    mode: str  # "query" | "document"


class EmbedResponse(BaseModel):
    vector: list[float]
    dim: int


@app.post("/embed", response_model=EmbedResponse)
def embed(req: EmbedRequest) -> EmbedResponse:
    if req.mode not in ("query", "document"):
        raise HTTPException(status_code=400, detail="mode must be 'query' or 'document'")
    with torch.inference_mode():
        if req.mode == "query":
            vec = model.encode_query(req.text, tokenizer)
        else:
            vec = model.encode_document(req.text, tokenizer)
    # encode_* は (1, hidden_size) を返す。squeeze して 1 次元にする
    vec_list = vec.squeeze(0).cpu().float().tolist()
    return EmbedResponse(vector=vec_list, dim=len(vec_list))


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}
