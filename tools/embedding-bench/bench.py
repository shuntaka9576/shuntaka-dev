# cspell:ignore jagovfaqs mintaka embeddinggemma ndcg
"""EmbeddingGemma 2 と PLaMo Embedding 1B の日本語検索性能を JMTEB-lite で比較する.

- embed: コーパスとクエリを推論サーバーの `/embed` で 1 件ずつ埋め込み、SQLite
  ($BENCH_CACHE_DIR/bench.sqlite, 既定は .cache/) に保存する。保存済みの id は飛ばすので中断しても再開できる。
- eval: 全クエリ × 全コーパスの cosine 類似度を総当たりし (exact KNN)、正解文書の順位から
  nDCG@10 / Recall@10 / Recall@100 / MRR@10 を百分率で出す。公式スコアとの照合用に、JMTEB v1 の評価器と
  同じ数え方の nDCG@10 (jmteb_ndcg@10) も出す。
- stats: embed 時に記録した 1 件あたりのレイテンシを集計する。

推論サーバーのエンドポイントは環境変数 PLAMO_EMBED_ENDPOINT / GEMMA_EMBED_ENDPOINT で渡す。
"""

import argparse
import os
import sqlite3
import statistics
import time
import urllib.request
from pathlib import Path

import httpx
import numpy as np
import pyarrow.parquet as pq

HF_BASE = "https://huggingface.co/datasets/sbintuitions/JMTEB-lite/resolve/main/data"
CACHE_DIR = Path(os.environ.get("BENCH_CACHE_DIR") or Path(__file__).parent / ".cache")
DB_PATH = CACHE_DIR / "bench.sqlite"

# 短い名前 -> JMTEB-lite の config 名
TASKS = {
    "nlp_journal_title_abs": "nlp_journal_title_abs",
    "mintaka": "mintaka-retrieval",
    "jagovfaqs_22k": "jagovfaqs_22k",
}
MODELS = ["plamo", "gemma"]


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
        # mintaka のコーパスは同じ docid / text の行が重複している (2,313 行で docid は 1,592 種類)。
        # docid 単位で 1 件にまとめ、元の行数を copies に残す (jmteb_ndcg@10 で使う)。
        corpus: dict[str, dict] = {}
        for r in rows:
            doc = corpus.setdefault(str(r["docid"]), {"id": str(r["docid"]), "text": r["text"], "copies": 0})
            doc["copies"] += 1
        return list(corpus.values())
    queries = []
    for i, r in enumerate(rows):
        # 3 タスクとも正解文書はクエリごとに 1 件 (nlp_journal は文字列、ほかは長さ 1 のリスト)
        rel = r["relevant_docs"]
        (relevant,) = [rel] if isinstance(rel, str) else rel
        # qid 列があるのは nlp_journal だけ。ほかは行番号を id にする
        queries.append({"id": str(r.get("qid", i)), "text": r["query"], "relevant": str(relevant)})
    return queries


def cmd_embed(args: argparse.Namespace) -> None:
    name = f"{args.model.upper()}_EMBED_ENDPOINT"
    if not os.environ.get(name):
        raise SystemExit(f"{name} is not set")
    url = os.environ[name] + "/embed"
    conn = connect()
    client = httpx.Client(timeout=300)
    for task in args.tasks:
        for kind in ("query", "corpus"):
            key = (args.model, task, kind)
            done = {
                r[0] for r in conn.execute("SELECT id FROM embeddings WHERE model = ? AND task = ? AND kind = ?", key)
            }
            items = [x for x in load_split(task, kind) if x["id"] not in done]
            print(f"[{args.model}] {task}/{kind}: {len(done)} done, {len(items)} remaining", flush=True)
            mode = "query" if kind == "query" else "document"
            batch: list[tuple] = []
            started = time.perf_counter()
            for n, item in enumerate(items, 1):
                start = time.perf_counter()
                res = client.post(url, json={"text": item["text"], "mode": mode})
                res.raise_for_status()
                latency_ms = round((time.perf_counter() - start) * 1000)
                vec = np.asarray(res.json()["vector"], dtype="<f4")
                if not np.isfinite(vec).all():
                    raise ValueError(f"vector contains a non-finite value: id={item['id']}")
                batch.append((*key, item["id"], vec.tobytes(), len(item["text"]), latency_ms))
                if len(batch) == 50 or n == len(items):
                    conn.executemany("INSERT INTO embeddings VALUES (?, ?, ?, ?, ?, ?, ?)", batch)
                    conn.commit()
                    batch.clear()
                    elapsed = time.perf_counter() - started
                    eta = elapsed / n * (len(items) - n)
                    print(f"  {n}/{len(items)} elapsed={elapsed / 60:.1f}m eta={eta / 60:.1f}m", flush=True)


def load_matrix(conn, model: str, task: str, kind: str, ids: list[str]) -> np.ndarray | None:
    """ids の順に並べたベクトル行列を返す。埋め込みが揃っていなければ None。"""
    vectors = dict(
        conn.execute("SELECT id, vector FROM embeddings WHERE model = ? AND task = ? AND kind = ?", (model, task, kind))
    )
    if len(vectors) != len(ids):
        print(f"skip {task}/{model}: {kind} {len(vectors)}/{len(ids)}", flush=True)
        return None
    return np.stack([np.frombuffer(vectors[i], dtype="<f4") for i in ids])


def cmd_eval(args: argparse.Namespace) -> None:
    conn = connect()
    results = []
    for task in args.tasks:
        queries = load_split(task, "query")
        corpus = load_split(task, "corpus")
        doc_index = {d["id"]: i for i, d in enumerate(corpus)}
        relevant = np.array([doc_index[q["relevant"]] for q in queries])
        copies = np.array([d["copies"] for d in corpus])
        for model in args.models:
            q_full = load_matrix(conn, model, task, "query", [q["id"] for q in queries])
            c_full = load_matrix(conn, model, task, "corpus", [d["id"] for d in corpus])
            if q_full is None or c_full is None:
                continue
            for dim in args.dims or [c_full.shape[1]]:
                # MRL: 先頭 dim 次元で切り詰めてから正規化する (フル次元なら切り詰めなし)
                q_mat = q_full[:, :dim] / np.linalg.norm(q_full[:, :dim], axis=1, keepdims=True)
                c_mat = c_full[:, :dim] / np.linalg.norm(c_full[:, :dim], axis=1, keepdims=True)
                # exact KNN: 全コーパスとの cosine を計算し、正解文書より類似度が高い文書の数から順位を出す
                scores = q_mat @ c_mat.T
                higher = scores > scores[np.arange(len(queries)), relevant][:, None]
                rank = higher.sum(axis=1) + 1
                # JMTEB v1 の評価器は重複行を残したまま上位 10 件を数え、正解の重複行が入るたびに加点する。
                # 正解の重複行は同じ類似度なので、raw_rank から copies 個が連続して並ぶ。
                raw_rank = higher @ copies + 1
                jmteb_ndcg = sum(
                    np.where((j < copies[relevant]) & (raw_rank + j <= 10), 1 / np.log2(raw_rank + j + 1), 0)
                    for j in range(10)
                )
                results.append(
                    {
                        "task": task,
                        "model": model,
                        "dim": dim,
                        "queries": len(queries),
                        "ndcg@10": round(np.where(rank <= 10, 1 / np.log2(rank + 1), 0).mean() * 100, 2),
                        "recall@10": round((rank <= 10).mean() * 100, 2),
                        "recall@100": round((rank <= 100).mean() * 100, 2),
                        "mrr@10": round(np.where(rank <= 10, 1 / rank, 0).mean() * 100, 2),
                        "jmteb_ndcg@10": round(jmteb_ndcg.mean() * 100, 2),
                    }
                )
    cols = ["task", "model", "dim", "queries", "ndcg@10", "recall@10", "recall@100", "mrr@10", "jmteb_ndcg@10"]
    print_table(results, cols)


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
    print("\n| " + " | ".join(cols) + " |")
    print("|" + "|".join(" --- " for _ in cols) + "|")
    for r in rows:
        print("| " + " | ".join(str(r[c]) for c in cols) + " |")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("embed", help="コーパスとクエリを埋め込んで SQLite に保存する")
    p.add_argument("--model", choices=MODELS, required=True)
    p.add_argument("--tasks", nargs="+", choices=list(TASKS), default=list(TASKS))
    p.set_defaults(func=cmd_embed)

    p = sub.add_parser("eval", help="exact KNN で検索精度を測る")
    p.add_argument("--models", nargs="+", choices=MODELS, default=MODELS)
    p.add_argument("--tasks", nargs="+", choices=list(TASKS), default=list(TASKS))
    p.add_argument("--dims", nargs="+", type=int, help="MRL の切り詰め次元 (例: --dims 768 256)。省略時はフル次元")
    p.set_defaults(func=cmd_eval)

    p = sub.add_parser("stats", help="埋め込みレイテンシを集計する")
    p.add_argument("--models", nargs="+", choices=MODELS, default=MODELS)
    p.add_argument("--tasks", nargs="+", choices=list(TASKS), default=list(TASKS))
    p.set_defaults(func=cmd_stats)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
