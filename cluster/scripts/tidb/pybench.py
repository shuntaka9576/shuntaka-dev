#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pymysql>=1.1"]
# ///
"""Point-select QPS bench against TiDB.

Spawns N worker threads (each with its own MySQL connection) doing PK lookups
on bench.load_test for TIME seconds. Reports total queries, QPS, p50/p95/p99.

env:
  TIDB_HOST  default tidb.<tailnet>.ts.net
  TIDB_PORT  default 4000
  TIDB_USER  default root
  TIDB_PASS  default ""
  TIDB_DB    default bench
  ROWS       default 1000000
  TIME       default 15  (seconds per concurrency)

usage:
  ./pybench.py [threads ...]            # default sweep: 32 64 128 256
  TIME=30 ./pybench.py 128
"""
import os
import sys
import time
import random
import threading
import statistics
import pymysql

HOST = os.environ.get("TIDB_HOST", "tidb.<tailnet>.ts.net")
PORT = int(os.environ.get("TIDB_PORT", "4000"))
USER = os.environ.get("TIDB_USER", "root")
PASS = os.environ.get("TIDB_PASS", "")
DB   = os.environ.get("TIDB_DB", "bench")
TIME_S = int(os.environ.get("TIME", "15"))
ROWS = int(os.environ.get("ROWS", "1000000"))

THREADS_DEFAULT = [32, 64, 128, 256]


def run(threads: int) -> dict:
    barrier = threading.Barrier(threads + 1)
    results: dict[int, tuple[int, list[float]]] = {}
    deadline = {"t": 0.0}

    def worker(idx: int):
        conn = pymysql.connect(
            host=HOST, port=PORT, user=USER, password=PASS, database=DB,
            autocommit=True, charset="utf8mb4",
        )
        cur = conn.cursor()
        rnd = random.Random(idx * 7919 + 13)
        lats: list[float] = []
        n = 0
        barrier.wait()
        end = deadline["t"]
        while True:
            t0 = time.perf_counter()
            cur.execute("SELECT id, v FROM load_test WHERE id = %s",
                        (rnd.randint(1, ROWS),))
            cur.fetchone()
            lats.append((time.perf_counter() - t0) * 1000.0)
            n += 1
            if time.perf_counter() >= end:
                break
        results[idx] = (n, lats)
        cur.close()
        conn.close()

    ts = [threading.Thread(target=worker, args=(i,), daemon=True)
          for i in range(threads)]
    for t in ts:
        t.start()
    start = time.perf_counter()
    deadline["t"] = start + TIME_S
    barrier.wait()
    for t in ts:
        t.join()
    elapsed = time.perf_counter() - start

    total_q = sum(n for n, _ in results.values())
    all_lats = sorted(x for _, lats in results.values() for x in lats)

    def pct(p: float) -> float:
        if not all_lats:
            return 0.0
        return all_lats[min(len(all_lats) - 1, int(len(all_lats) * p))]

    return {
        "threads": threads,
        "qps": total_q / elapsed,
        "lat_avg": statistics.mean(all_lats) if all_lats else 0.0,
        "lat_p50": pct(0.50),
        "lat_p95": pct(0.95),
        "lat_p99": pct(0.99),
        "lat_max": max(all_lats) if all_lats else 0.0,
    }


def main():
    threads_list = [int(x) for x in sys.argv[1:]] or THREADS_DEFAULT
    print(f"target: {HOST}:{PORT}  db={DB}  rows={ROWS}  time={TIME_S}s")
    print(f"{'threads':>8} {'QPS':>10} {'avg ms':>8} {'p50':>6} {'p95':>6} {'p99':>6} {'max':>8}")
    for t in threads_list:
        r = run(t)
        print(f"{r['threads']:>8} {r['qps']:>10.0f} {r['lat_avg']:>8.2f} "
              f"{r['lat_p50']:>6.2f} {r['lat_p95']:>6.2f} {r['lat_p99']:>6.2f} {r['lat_max']:>8.1f}")


if __name__ == "__main__":
    main()
