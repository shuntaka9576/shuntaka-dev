<!-- cspell:ignore jagovfaqs mintaka embeddinggemma ndcg Matryoshka -->

# EmbeddingGemma 2 と PLaMo Embedding の日本語検索性能比較（JMTEB-lite, exact KNN）

- 対象: [`google/embeddinggemma-2`](https://huggingface.co/google/embeddinggemma-2) と [`pfnet/plamo-embedding-1b`](https://huggingface.co/pfnet/plamo-embedding-1b)
- 調査日: 2026-10-07
- 実体: [`cluster/manifests/embedding-bench/`](../../../../cluster/manifests/embedding-bench/services.yaml)（推論サーバー）、[`tools/embedding-bench/`](../../../../tools/embedding-bench/bench.py)（ベンチのクライアント）

## 目的

2026-10-06 に公開された EmbeddingGemma 2（[Launch Blog](https://blog.google/innovation-and-ai/technology/developers-tools/embeddinggemma-2/)）は、多言語対応の embedding モデルで、テキスト部分は 270M パラメータと小さい。一方 PLaMo Embedding 1B は日本語に特化した約 1B パラメータのモデルで、日本語の embedding ベンチマーク JMTEB で高いスコアを出している。

この 2 つを、**日本語の検索タスクでの精度**と、**CPU だけの小型マシン（MiniPC）での速度・メモリ**の両面から、同じ条件で比べる。

比べるのは embedding モデルそのものに絞る。ベクトル DB や近似最近傍探索（HNSW など）を挟むと、その近似誤差で結果がぶれる。そのためベクトルは SQLite に保存し、評価は numpy の総当たり（exact KNN）で行う。

## 比較対象

|              | PLaMo Embedding 1B                       | EmbeddingGemma 2                                                            |
| ------------ | ---------------------------------------- | --------------------------------------------------------------------------- |
| 開発元       | Preferred Networks                       | Google DeepMind                                                             |
| パラメータ   | 約 1B                                    | 270M（text のみ。transformer 130M + embedder 140M）                         |
| 対応言語     | 日本語特化                               | 100 以上の言語                                                              |
| 次元         | 2048                                     | 768（MRL で 512 / 256 / 128 に切り詰め可）                                  |
| 最大入力長   | 4,096 token（学習時は 1,024 まで）       | 8,192 token                                                                 |
| 入力の書式   | `encode_query` / `encode_document`       | クエリ `task: search result \| query: ...`、文書 `title: none \| text: ...` |
| 推論の精度   | float32                                  | float32（float16 は NaN になるため不可）                                    |
| ライセンス   | Apache 2.0                               | Apache 2.0                                                                  |

## データセット

[JMTEB-lite](https://huggingface.co/datasets/sbintuitions/JMTEB-lite)（JMTEB の検索タスクのコーパスを縮小した軽量版）の retrieval タスクから 3 つを使う。クエリは test split。

| タスク                | コーパス | クエリ | 平均文字数（コーパス / クエリ） | 内容                          |
| --------------------- | -------: | -----: | ------------------------------: | ----------------------------- |
| nlp_journal_title_abs |      637 |    510 |                        462 / 28 | 論文タイトル → アブストラクト |
| mintaka               |    2,313 |  2,313 |                          9 / 30 | 質問 → 答えのエンティティ名   |
| jagovfaqs_22k         |   22,794 |  3,420 |                        210 / 60 | 行政 FAQ の質問 → 回答        |

PLaMo は JMTEB でスコアを公開しているモデルなので、JMTEB の train split が学習に使われている可能性は残る。

## 評価方法

- 各タスクのコーパスとクエリをすべて埋め込み、全クエリ × 全コーパスの cosine 類似度を計算して上位 100 件を取る（exact KNN）
- 指標は JMTEB の主指標である nDCG@10 と、Recall@10 / Recall@100 / MRR@10。関連度は二値（正解文書に含まれるか）
- EmbeddingGemma 2 は MRL（Matryoshka Representation Learning）で学習されているので、768 次元のベクトルを先頭 512 / 256 / 128 次元で切って再正規化した場合の精度も、追加の埋め込みなしで測る
- 速度は 1 件ずつ直列にリクエストし、1 件ごとのレイテンシ（クライアントから見た往復時間）を記録する。メモリは推論サーバーの Pod の `memory.peak`（cgroup v2）で測る

## 検証環境

| 項目         | 内容                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------ |
| マシン       | GMKtec M5 Ultra（Ryzen 7 7730U 8 コア 16 スレッド / DDR4 32GB）× 3 台（node1 / node2 / node3） |
| OS / k8s     | Ubuntu Server 24.04 LTS、kubeadm v1.31 系                                                  |
| GPU          | なし（CPU 推論のみ）                                                                       |
| ネットワーク | 2.5GbE                                                                                     |

同じクラスタでは TiDB（PD / TiKV / TiDB / TiFlash）などの他のワークロードも動いている。推論サーバーを置く node1 には TiFlash が、クライアントを置く node2 には別の推論サーバーの Pod が同居する。どちらも検証中に大きな負荷はかからない想定だが、計測値にはこれらのノイズが多少含まれる。

### 構成

2 つの推論サーバーを、**同じ node1 に、同じ resources で、1 つずつ順に立てる**。クライアントは別ノード（node2）の作業ディレクトリから、Service の ClusterIP 経由で叩く。

```{mermaid}
flowchart LR
  subgraph node2["node2（作業ディレクトリ ~/work/20261007-embedding-bench）"]
    B[bench.py]
    DB[(data/bench.sqlite)]
  end
  subgraph node1
    P[bench-plamo Pod<br/>① 先に立てて埋め込み、終わったら消す]
    G[bench-gemma Pod<br/>② 次に立てて埋め込み、終わったら消す]
  end
  B -- "/embed（ClusterIP）" --> P
  B -- "/embed（ClusterIP）" --> G
  B --> DB
```

- 推論サーバーはどちらも FastAPI のラッパーで、`POST /embed` に `{"text": "...", "mode": "query" | "document"}` を投げると 1 本のベクトルを返す。同じ形にそろえてあるので、クライアントは `bench.py` 1 本で済む
  - PLaMo: [`cluster/manifests/plamo-embedding/`](../../../../cluster/manifests/plamo-embedding/server.py) の image を digest 固定で使う
  - EmbeddingGemma 2: [`cluster/manifests/embedding-bench/gemma/`](../../../../cluster/manifests/embedding-bench/gemma/server.py) からビルドした image（タグ `2026-10-07`）
- 2 つの Deployment（`plamo.yaml` / `gemma.yaml`）は nodeSelector（node1）、resources（CPU limit なし、memory limit 8Gi）、probe をそろえてある。どちらの image も python:3.13-slim + CPU 版 PyTorch + jemalloc
- サーバーを同時には動かさないので、CPU を取り合わない。同じ条件で順に流すため、記録したレイテンシはそのまま両モデルで比べられる
- 長時間の処理を手元の Mac から回すと、回線切れやスリープで止まる。そのためクライアントもクラスタのノード上で tmux の中で動かす
- SQLite は 1 テーブル（`embeddings`: model, task, kind, id, vector, chars, latency_ms）。保存済みの id は飛ばすので、止まっても同じコマンドで続きから再開できる

## 所要時間の見込み

事前に、MiniPC 上で動いている PLaMo の推論サーバーへ手元の Mac から直列にリクエストして測った値（Tailnet 経由、2026-10-07）は、クエリ（約 60 文字）が 0.86 秒、文書（約 210 文字）が 1.3 秒、文書（約 600 文字）が 3.0 秒だった。ここから見積もった PLaMo の所要時間は次のとおり。

| タスク                | PLaMo（並列 1） |
| --------------------- | --------------: |
| nlp_journal_title_abs |        約 35 分 |
| mintaka               |       約 1 時間 |
| jagovfaqs_22k         |  約 10〜11 時間 |

EmbeddingGemma 2 は計算量が PLaMo の 1/7 程度で、Mac（Apple Silicon）の CPU では 60 / 210 / 600 文字がそれぞれ 38 / 75 / 143ms だった。MiniPC では全タスクで 1〜3 時間程度と見込む。順に流すので合計 13〜15 時間程度になる。

## 事前確認済みのこと（2026-10-07）

| 項目                                                                                            | 結果                                                                           |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| EmbeddingGemma 2 を transformers 5.19.0 / sentence-transformers 6.1.0 / torch 2.14.1 で読み込む | Mac CPU で OK。text のみ 271M パラメータ、float32、最大 RSS 約 1.3GB           |
| text のみの場合に必要な追加依存                                                                 | `torchvision` と `pillow`（Processor が Gemma 4 の画像処理を import するため） |
| `gemma/server.py` の `/embed` と `/healthz`                                                     | Mac で起動して確認。768 次元を返し、不正な `mode` は 400                       |
| `bench.py eval` の指標計算                                                                      | 合成ベクトルで確認（正解との対応が取れていれば 1.0、ノイズを強くすると下がる） |
| node1 / node2 の空きメモリ                                                                      | node1 約 23GB、node2 約 21GB                                                   |
| node2 から ClusterIP / PyPI プロキシ / Hugging Face への疎通                                    | すべて OK（ClusterIP は別の Service で確認）                                   |
| node2 のツール                                                                                  | tmux、Python 3.12.3 あり。uv はない（手順 3 で入れる。node1 と同じ 0.11.29）   |

**まだ確認していないこと**: linux/amd64 での EmbeddingGemma 2 の image のビルド、推論サーバーの Pod の起動、node2 での venv 構築と実行。

## 手順

### 1. EmbeddingGemma 2 の image をビルドして push（Mac、リポジトリのルートで）

EmbeddingGemma 2（`model_type: embedding_gemma2`）は transformers 5.19.0（2026-10-06 リリース）で追加された。普段使っている PyPI プロキシ（`pypi.flatt.tech`）にはまだ配信されていないため、今回は検証用途に限り、Dockerfile 内の `pip install` で公式 PyPI から取得する。PLaMo は既存の image を使うのでビルド不要。

```bash
# Mac で実行する
./cluster/manifests/embedding-bench/gemma/build-and-push.sh
```

### 2. namespace と Service を作る（Mac）

```bash
# Mac で実行する
kubectl apply -f cluster/manifests/embedding-bench/services.yaml
```

### 3. node2 に作業ディレクトリを作る

Mac から作業ディレクトリを作り、`bench.py` と `requirements.txt` を送る。続けて、Service の ClusterIP を kubectl で取って `env.sh` を生成し、node2 に書き込む（IP を手で書き写す必要はない）。

```bash
# Mac で実行する（node2 には kubectl の接続設定がない）
ssh node2 'mkdir -p ~/work/20261007-embedding-bench/{logs,results}'
scp tools/embedding-bench/{bench.py,requirements.txt} node2:~/work/20261007-embedding-bench/

PLAMO_IP=$(kubectl -n embedding-bench get svc bench-plamo -o jsonpath='{.spec.clusterIP}')
GEMMA_IP=$(kubectl -n embedding-bench get svc bench-gemma -o jsonpath='{.spec.clusterIP}')
ssh node2 'cat > ~/work/20261007-embedding-bench/env.sh' <<EOF
cd ~/work/20261007-embedding-bench
export BENCH_CACHE_DIR=\$HOME/work/20261007-embedding-bench/data
export PLAMO_EMBED_ENDPOINT=http://${PLAMO_IP}
export GEMMA_EMBED_ENDPOINT=http://${GEMMA_IP}
EOF
ssh node2 'cat ~/work/20261007-embedding-bench/env.sh'
```

node2 に uv を入れて venv を作る。クライアントの依存（httpx / numpy / pyarrow）は `pypi.flatt.tech` から入れる。

```bash
# Mac から node2 に入って実行する
ssh node2
cd ~/work/20261007-embedding-bench

curl -LsSf https://astral.sh/uv/0.11.29/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
uv venv --python 3.12 .venv
uv pip install --python .venv --index-url https://pypi.flatt.tech/simple/ -r requirements.txt
```

### 4. PLaMo のサーバーを立てて埋め込む（約 12 時間）

`plamo.yaml` / `gemma.yaml` には Deployment しか入っていない。namespace は手順 2 の `services.yaml` で作るので、先に手順 2 を済ませておく（済んでいないと `namespaces "embedding-bench" not found` で失敗する）。namespace と Service を `services.yaml` に分けているのは、`kubectl delete -f plamo.yaml` でサーバーを消したときに namespace や Service まで消えて ClusterIP が変わらないようにするため。

Mac でサーバーを立てる。

```bash
# Mac で実行する
kubectl apply -f cluster/manifests/embedding-bench/plamo.yaml
kubectl -n embedding-bench rollout status deployment/bench-plamo --timeout=10m
```

node2 で疎通を確かめてから流す。

```bash
# node2 で実行する
source ~/work/20261007-embedding-bench/env.sh
curl -sf "$PLAMO_EMBED_ENDPOINT/healthz"; echo

tmux new -d -s embed-plamo 'source ~/work/20261007-embedding-bench/env.sh && .venv/bin/python bench.py embed --model plamo 2>&1 | tee -a logs/embed-plamo.log'
tail -f logs/embed-plamo.log    # Ctrl-C で抜ける（処理は止まらない）
```

SSH を切っても tmux の中で動き続ける。進捗は `n/total elapsed eta` の行で見る。途中で止まった場合は、同じ `tmux new ...` を打ち直せば保存済みの続きから再開する。

終わったら（`tmux ls` から `embed-plamo` が消えたら）、Mac でメモリのピークを控えてからサーバーを消す。

```bash
# Mac で実行する
kubectl -n embedding-bench exec deploy/bench-plamo -- cat /sys/fs/cgroup/memory.peak
kubectl delete -f cluster/manifests/embedding-bench/plamo.yaml
```

### 5. EmbeddingGemma 2 のサーバーを立てて埋め込む（約 1〜3 時間）

手順 4 と同じ流れ。Mac でサーバーを立てる。

```bash
# Mac で実行する
kubectl apply -f cluster/manifests/embedding-bench/gemma.yaml
kubectl -n embedding-bench rollout status deployment/bench-gemma --timeout=10m
```

node2 で流す。

```bash
# node2 で実行する
source ~/work/20261007-embedding-bench/env.sh
curl -sf "$GEMMA_EMBED_ENDPOINT/healthz"; echo

tmux new -d -s embed-gemma 'source ~/work/20261007-embedding-bench/env.sh && .venv/bin/python bench.py embed --model gemma 2>&1 | tee -a logs/embed-gemma.log'
tail -f logs/embed-gemma.log
```

終わったら、Mac でメモリのピークを控えてからサーバーを消す。

```bash
# Mac で実行する
kubectl -n embedding-bench exec deploy/bench-gemma -- cat /sys/fs/cgroup/memory.peak
kubectl delete -f cluster/manifests/embedding-bench/gemma.yaml
```

### 6. 評価する（node2）

埋め込みが終わっていないタスクは `skip ...` と表示されて飛ばされる。

```bash
# node2 で実行する
source ~/work/20261007-embedding-bench/env.sh
.venv/bin/python bench.py stats | tee results/stats.md
.venv/bin/python bench.py eval | tee results/eval.md
.venv/bin/python bench.py eval --models gemma --dims 768 512 256 128 | tee results/eval-gemma-mrl.md
```

結果を Mac に持ってくる場合は次のとおり。

```bash
# Mac で実行する
scp -r node2:~/work/20261007-embedding-bench/results ./embedding-bench-results
```

### 7. 後片付け

結果を下の「結果」に貼ってから消す。node2 の作業ディレクトリには venv と SQLite（約 400MB）が入っている。uv は他でも使うなら残してよい。

```bash
# Mac
kubectl delete namespace embedding-bench

# node2
rm -rf ~/work/20261007-embedding-bench
```

## 結果

未実施。`results/*.md` の中身と、手順 4 / 5 で控えた `memory.peak` をここに貼る。

### 検索精度（フル次元）

| task | model | dim | queries | ndcg@10 | recall@10 | recall@100 | mrr@10 |
| ---- | ----- | --: | ------: | ------: | --------: | ---------: | -----: |
|      |       |     |         |         |           |            |        |

### EmbeddingGemma 2 の MRL 切り詰め

| task | dim | ndcg@10 | recall@10 | recall@100 | mrr@10 |
| ---- | --: | ------: | --------: | ---------: | -----: |
|      |     |         |           |            |        |

### 埋め込みレイテンシ / メモリ

| model | kind | p50_ms | p95_ms | memory.peak |
| ----- | ---- | -----: | -----: | ----------: |
|       |      |        |        |             |

## 考察

結果が出たら書く。
