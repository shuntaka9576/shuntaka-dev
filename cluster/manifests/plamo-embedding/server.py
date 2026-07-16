# cspell:ignore healthz
"""PLaMo Embedding 1B の HTTP wrapper.

`POST /embed` に {"text": "...", "mode": "query"|"document"} を投げると、
2048 次元の float 配列を返す。`POST /chunks` は同じtokenizerを使い、Markdownを
学習時のcontext長に合わせて分割する。tidb-embedder (backfill) と blog-api (検索) が
同じServiceを利用する。
"""
import logging
import os

import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, model_validator
from transformers import AutoModel, AutoTokenizer

from chunking import CHUNKING_VERSION, chunk_document

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


class ChunksRequest(BaseModel):
    title: str
    description: str = ""
    content: str
    max_tokens: int = Field(default=1024, ge=64, le=4096)
    overlap_tokens: int = Field(default=128, ge=0)

    @model_validator(mode="after")
    def validate_overlap(self) -> "ChunksRequest":
        if self.overlap_tokens >= self.max_tokens:
            raise ValueError("overlap_tokens must be less than max_tokens")
        return self


class ChunkResponseItem(BaseModel):
    index: int
    heading: str | None
    content: str
    embedding_text: str
    token_count: int


class ChunksResponse(BaseModel):
    version: str
    max_tokens: int
    overlap_tokens: int
    chunks: list[ChunkResponseItem]


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


@app.post("/chunks", response_model=ChunksResponse)
def chunks(req: ChunksRequest) -> ChunksResponse:
    items = chunk_document(
        tokenizer,
        title=req.title,
        description=req.description,
        content=req.content,
        max_tokens=req.max_tokens,
        overlap_tokens=req.overlap_tokens,
    )
    return ChunksResponse(
        version=CHUNKING_VERSION,
        max_tokens=req.max_tokens,
        overlap_tokens=req.overlap_tokens,
        chunks=[ChunkResponseItem(**item.__dict__) for item in items],
    )


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}
