# cspell:ignore jagovfaqs mintaka embeddinggemma ndcg argpartition
"""embedding モデルの日本語検索性能を JMTEB-lite で単純比較する.

- embed: JMTEB-lite のコーパスとクエリを各モデルの `/embed` で埋め込み、ローカルの
  SQLite ($BENCH_CACHE_DIR/bench.sqlite, 既定は .cache/) に保存する。保存済みの id は飛ばすので中断しても再開できる。
- eval: 全クエリ × 全コーパスの cosine 類似度を numpy で総当たりし (exact KNN, ANN なし)、
  nDCG@10 / Recall@10 / Recall@100 / MRR@10 を出す。
- stats: embed 時に記録した 1 件あたりのレイテンシを集計する。

モデルの推論サーバーは `/embed` 契約 ({"text", "mode"} -> {"vector", "dim"}) で立て、
エンドポイントを環境変数 <NAME>_EMBED_ENDPOINT (例: PLAMO_EMBED_ENDPOINT) で渡す。
モデルを足すときは MODELS に名前を 1 つ追加する。
"""

import argparse
import math
import os
import sqlite3
import statistics
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import httpx
import numpy as np
import pyarrow.parquet as pq

HF_BASE = "https://huggingface.co/datasets/sbintuitions/JMTEB-lite/resolve/main/data"
# MiniPC の作業ディレクトリでは BENCH_CACHE_DIR に作業ディレクトリ配下を渡す
CACHE_DIR = Path(os.environ.get("BENCH_CACHE_DIR") or Path(__file__).parent / ".cache")
DB_PATH = CACHE_DIR / "bench.sqlite"

# 短い名前 -> JMTEB-lite の config 名
TASKS = {
    "nlp_journal_title_abs": "nlp_journal_title_abs",
    "mintaka": "mintaka-retrieval",
    "jagovfaqs_22k": "jagovfaqs_22k",
}

MODELS = ["plamo", "gemma"]


def endpoint(model: str) -> str:
    name = f"{model.upper()}_EMBED_ENDPOINT"
    env = os.environ.get(name)
    if not env:
        raise SystemExit(f"{name} is not set")
    return env


def connect() -> sqlite3.Connection:
    CACHE_DIR.mkdir(exist_ok=True)
    # embed の投入中に別プロセスから eval / stats を流しても読めるよう WAL + busy timeout にする
    conn = sqlite3.connect(DB_PATH, timeout=60)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(
        """CREATE TABLE IF NOT EXISTS embeddings (
          model TEXT NOT NULL,
          task TEXT NOT NULL,
          kind TEXT NOT NULL,  -- corpus | query
          id TEXT NOT NULL,
          vector BLOB NOT NULL,  -- float32 little-endian
          chars INTEGER NOT NULL,
          latency_ms INTEGER NOT NULL,
          PRIMARY KEY (model, task, kind, id)
        )"""
    )
    return conn


def load_split(task: str, kind: str) -> list[dict]:
    """kind は "corpus" | "query"。query は test split を使う。"""
    config = TASKS[task]
    path = CACHE_DIR / f"{config}-{kind}.parquet"
    if not path.exists():
        CACHE_DIR.mkdir(exist_ok=True)
        split = "corpus" if kind == "corpus" else "test"
        urllib.request.urlretrieve(f"{HF_BASE}/{config}-{kind}/{split}.parquet", path)
    rows = pq.read_table(path).to_pylist()
    if kind == "corpus":
        # mintaka のコーパスは同じ答えを持つ質問の数だけ同じ docid / text の行が重複している
        # (2,313 行で docid は 1,592 種類)。docid 単位で 1 件にまとめる。
        corpus: dict[str, dict] = {}
        for r in rows:
            corpus.setdefault(str(r["docid"]), {"id": str(r["docid"]), "text": r["text"]})
        return list(corpus.values())
    items = []
    for i, r in enumerate(rows):
        rel = r["relevant_docs"]
        rel = [rel] if isinstance(rel, str) else rel
        items.append({"id": str(r.get("qid", i)), "text": r["query"], "relevant": [str(d) for d in rel]})
    return items


def cmd_embed(args: argparse.Namespace) -> None:
    url = endpoint(args.model) + "/embed"
    conn = connect()
    for task in args.tasks:
        for kind in ("query", "corpus"):
            done = {
                r[0]
                for r in conn.execute(
                    "SELECT id FROM embeddings WHERE model = ? AND task = ? AND kind = ?", (args.model, task, kind)
                )
            }
            items = [x for x in load_split(task, kind)[: args.limit] if x["id"] not in done]
            print(f"[{args.model}] {task}/{kind}: {len(done)} done, {len(items)} remaining", flush=True)
            if items:
                mode = "query" if kind == "query" else "document"
                embed_items(conn, url, (args.model, task, kind), items, mode, args.concurrency)


def embed_items(conn, url: str, key: tuple, items: list[dict], mode: str, concurrency: int) -> None:
    local = threading.local()

    def work(item: dict) -> tuple:
        client = getattr(local, "client", None) or httpx.Client(timeout=300)
        local.client = client
        start = time.perf_counter()
        res = client.post(url, json={"text": item["text"], "mode": mode})
        res.raise_for_status()
        latency_ms = round((time.perf_counter() - start) * 1000)
        vec = np.asarray(res.json()["vector"], dtype="<f4")
        if not np.isfinite(vec).all():
            raise ValueError(f"vector contains a non-finite value: id={item['id']}")
        return (*key, item["id"], vec.tobytes(), len(item["text"]), latency_ms)

    batch: list[tuple] = []
    started = time.perf_counter()
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = [pool.submit(work, x) for x in items]
        for n, future in enumerate(as_completed(futures), 1):
            batch.append(future.result())
            if len(batch) >= 50 or n == len(items):
                conn.executemany("INSERT INTO embeddings VALUES (?, ?, ?, ?, ?, ?, ?)", batch)
                conn.commit()
                batch.clear()
                elapsed = time.perf_counter() - started
                eta = elapsed / n * (len(items) - n)
                print(f"  {n}/{len(items)} elapsed={elapsed / 60:.1f}m eta={eta / 60:.1f}m", flush=True)


def load_matrix(conn, model: str, task: str, kind: str, dim: int | None) -> tuple[list[str], np.ndarray]:
    rows = conn.execute(
        "SELECT id, vector FROM embeddings WHERE model = ? AND task = ? AND kind = ? ORDER BY id", (model, task, kind)
    ).fetchall()
    if not rows:
        return [], np.empty((0, 0), dtype=np.float32)
    mat = np.stack([np.frombuffer(v, dtype="<f4") for _, v in rows])
    if dim:
        # MRL: 先頭 dim 次元で切り詰めてから再正規化する
        mat = mat[:, :dim]
    mat = mat / np.linalg.norm(mat, axis=1, keepdims=True)
    return [r[0] for r in rows], mat


def metrics(ranked: list[str], relevant: set[str]) -> dict[str, float]:
    dcg = sum(1 / math.log2(i + 2) for i, d in enumerate(ranked[:10]) if d in relevant)
    idcg = sum(1 / math.log2(i + 2) for i in range(min(len(relevant), 10)))
    mrr = next((1 / (i + 1) for i, d in enumerate(ranked[:10]) if d in relevant), 0.0)
    return {
        "ndcg@10": dcg / idcg,
        "recall@10": len(relevant & set(ranked[:10])) / len(relevant),
        "recall@100": len(relevant & set(ranked[:100])) / len(relevant),
        "mrr@10": mrr,
    }


def cmd_eval(args: argparse.Namespace) -> None:
    conn = connect()
    results = []
    for task in args.tasks:
        labels = {q["id"]: set(q["relevant"]) for q in load_split(task, "query")}
        corpus_size = len(load_split(task, "corpus"))
        for model in args.models:
            for dim in args.dims or [None]:
                q_ids, q_mat = load_matrix(conn, model, task, "query", dim)
                c_ids, c_mat = load_matrix(conn, model, task, "corpus", dim)
                if len(q_ids) != len(labels) or len(c_ids) != corpus_size:
                    print(
                        f"skip {task}/{model}: query {len(q_ids)}/{len(labels)}, corpus {len(c_ids)}/{corpus_size}",
                        flush=True,
                    )
                    break
                if dim and dim > c_mat.shape[1]:
                    continue
                # exact KNN: 全件の cosine を計算し上位 100 件を取る
                scores = q_mat @ c_mat.T
                k = min(100, len(c_ids))
                top = np.argpartition(-scores, k - 1, axis=1)[:, :k]
                per_query = []
                for row, qid in enumerate(q_ids):
                    order = top[row][np.argsort(-scores[row, top[row]])]
                    per_query.append(metrics([c_ids[i] for i in order], labels[qid]))
                result = {"task": task, "model": model, "dim": c_mat.shape[1], "queries": len(per_query)}
                result |= {key: round(statistics.mean(m[key] for m in per_query), 4) for key in per_query[0]}
                results.append(result)
    print_table(results, ["task", "model", "dim", "queries", "ndcg@10", "recall@10", "recall@100", "mrr@10"])


def cmd_stats(args: argparse.Namespace) -> None:
    conn = connect()
    results = []
    for task in args.tasks:
        for model in args.models:
            for kind in ("query", "corpus"):
                rows = conn.execute(
                    "SELECT latency_ms, chars FROM embeddings WHERE model = ? AND task = ? AND kind = ? "
                    "ORDER BY latency_ms",
                    (model, task, kind),
                ).fetchall()
                if not rows:
                    continue
                lat = [r[0] for r in rows]
                results.append(
                    {
                        "task": task,
                        "model": model,
                        "kind": kind,
                        "n": len(lat),
                        "avg_chars": round(statistics.mean(r[1] for r in rows)),
                        "p50_ms": lat[len(lat) // 2],
                        "p95_ms": lat[int(len(lat) * 0.95)],
                        "total_min": round(sum(lat) / 60000, 1),
                    }
                )
    print_table(results, ["task", "model", "kind", "n", "avg_chars", "p50_ms", "p95_ms", "total_min"])


def print_table(rows: list[dict], cols: list[str]) -> None:
    if not rows:
        return
    print("\n| " + " | ".join(cols) + " |")
    print("|" + "|".join(" --- " for _ in cols) + "|")
    for r in rows:
        print("| " + " | ".join(str(r[c]) for c in cols) + " |")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    task_names = list(TASKS)

    p = sub.add_parser("embed", help="コーパスとクエリを埋め込んで SQLite に保存する")
    p.add_argument("--model", choices=MODELS, required=True)
    p.add_argument("--tasks", nargs="+", choices=task_names, default=task_names)
    p.add_argument("--concurrency", type=int, default=1, help="同時リクエスト数 (plamo は本番と共用なので 1 推奨)")
    p.add_argument("--limit", type=int, default=None, help="動作確認用に先頭 N 件だけ埋め込む")
    p.set_defaults(func=cmd_embed)

    p = sub.add_parser("eval", help="exact KNN で検索精度を測る")
    p.add_argument("--models", nargs="+", choices=MODELS, default=MODELS)
    p.add_argument("--tasks", nargs="+", choices=task_names, default=task_names)
    p.add_argument("--dims", nargs="+", type=int, help="MRL の切り詰め次元 (例: --dims 768 256)。省略時は全次元")
    p.set_defaults(func=cmd_eval)

    p = sub.add_parser("stats", help="埋め込みレイテンシを集計する")
    p.add_argument("--models", nargs="+", choices=MODELS, default=MODELS)
    p.add_argument("--tasks", nargs="+", choices=task_names, default=task_names)
    p.set_defaults(func=cmd_stats)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
