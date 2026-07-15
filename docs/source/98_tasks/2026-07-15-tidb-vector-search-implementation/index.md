# TiDB Vector 検索実装 (PLaMo Embedding 1B + TiFlash)

- 起票日: 2026-07-15
- 関連: [2026-07-15 TiDB FTS 構成調査 (Vector + TiFlash 採用)](../2026-07-15-tidb-fts-kuromoji-patterns/index.md), [`cluster/manifests/tidb-cluster/tidb-cluster.yaml`](../../../../cluster/manifests/tidb-cluster/tidb-cluster.yaml), [`tools/dsql-cli/dsl-tidb/schema/`](../../../../tools/dsql-cli/dsl-tidb/schema/), [`apps/blog-api/`](../../../../apps/blog-api/)
- ステータス: 進行中

## 起票理由

前タスク ([2026-07-15 TiDB FTS 構成調査](../2026-07-15-tidb-fts-kuromoji-patterns/index.md)) で「Self-Managed TiDB で日本語検索を実現するには Vector + TiFlash が唯一の TiDB 内完結案」という結論に至った。本 doc はその実装タスクとして、TiFlash 追加から検索エンドポイント公開までを 7 フェーズに分解し、各フェーズの具体的な作業内容・検証手順・本番展開手順を整理する。

## 全体アーキテクチャ

```
                                          ┌─ blog-api (search endpoint)
                                          │       │
                                          ▼       │ q="..."
                             PLaMo Embedding Service ◀─┘
                              (k8s Pod, /embed HTTP)
                                          ▲
                                          │ document embedding
        tidb-embedder (ローカル backfill) ─┤
        (embedding IS NULL の行だけ)      │
                                          ▼
                                TiDB (blog_dev / blog_prd)
                                articles.embedding VECTOR(2048)
                                + HNSW index on TiFlash replica

  ─ ─ ─ (最終フェーズ) ─ ─ ─
   GitHub webhook → blog-api が content 変更時に PLaMo → embedding を UPDATE
```

- 書き込み経路 (初期): ローカルから `tools/tidb-embedder` を叩いて `embedding IS NULL` の行だけ埋める
- 読み取り経路: blog-api の検索エンドポイントがクエリを PLaMo で vectorize → `VEC_COSINE_DISTANCE` で ORDER BY
- 継続更新 (webhook 経路): 全体が動き始めてから最後に組み込む。それまでは content 更新時にも embedding は更新されない (再度ローカルスクリプトで埋める運用)

## 実装フェーズ (チェックボックス管理)

- [x] Phase 1: TiFlash 追加 (manifest 編集 → apply → replica 確認) — 2026-07-15 完了
- [ ] Phase 2: PLaMo Embedding Service (k8s Pod + HTTP wrapper)
- [ ] Phase 3: `articles.embedding` 列 + HNSW インデックス追加 (DDL)
- [ ] Phase 4: `tools/tidb-embedder` 新規作成 (既存レコード埋め戻し、`embedding IS NULL` 対象)
- [ ] Phase 5: `blog-api` の検索エンドポイント実装
- [ ] Phase 6: 本番 (blog_prd) 適用 (TiFlash replica + DDL + backfill)
- [ ] Phase 7: GitHub webhook 経路への embedding 生成組み込み (継続更新)

## 前提

- `~/.kube/config-mycluster` から k8s クラスタに到達可能 (Tailscale 経由)
- `mysql` クライアントで dev DB (`blog_dev`) に接続できる
- リポジトリルート (`shuntaka-dev`) がカレントディレクトリ
- 開発環境のインフラ適用 (`kubectl apply`, DDL 実行, ツール実行) は **ユーザーが手動で実施する**。本 doc の作業指示は「編集内容 + 実行コマンド」のセットで書く

```bash
export KUBECONFIG=~/.kube/config-mycluster
export TAILNET=$(tailscale status --json | jq -r '.MagicDNSSuffix')
```

## 想定所要時間 (dev 環境)

| フェーズ                                    | 目安時間                    |
| ------------------------------------------- | --------------------------- |
| Phase 1: TiFlash 追加                       | 10 - 20 分                  |
| Phase 2: PLaMo Embedding Service            | 30 - 60 分 (初回 pull 込み) |
| Phase 3: DDL 適用                           | 5 分                        |
| Phase 4: tidb-embedder 実装 + 埋め戻し      | 60 分 + データ量依存        |
| Phase 5: 検索エンドポイント                 | 60 - 120 分                 |
| Phase 6: 本番適用                           | 30 分                       |
| Phase 7: webhook 組み込み (継続更新)        | 30 分                       |

---

## Phase 1: TiFlash 追加

### 1-1. 前提確認

TiFlash は各 k8s ノードのローカルディスクに DeltaTree ストレージを持つ。dev では 1 replica で十分。

- ノードに空きストレージがあること (`local-path` provisioner の PV が確保できる領域)
- 記事データは 2.5MB 程度と小さいので 20Gi あれば十分だが、将来の拡張を見越して **50Gi** で確保する
- TiFlash は arm64 対応済み (v8.5.7 の `pingcap/tiflash:v8.5.7` を使う)

```bash
kubectl -n tidb-cluster get tc basic -o jsonpath='{.spec.version}'
# → v8.5.7 が出ればよい

kubectl get nodes -o custom-columns=NAME:.metadata.name,ARCH:.status.nodeInfo.architecture
# → arm64 が並ぶこと (MiniPC クラスタ)
```

### 1-2. TidbCluster manifest 編集

`cluster/manifests/tidb-cluster/tidb-cluster.yaml` の `spec` に `tiflash` セクションを追加する。既存の `pd` / `tikv` / `tidb` と同じ書式 (baseImage, requests, config, topologySpreadConstraints, additionalVolumes) を踏襲する。

追加内容 (末尾に追記):

```yaml
  tiflash:
    baseImage: pingcap/tiflash
    replicas: 1
    requests:
      cpu: '500m'
      memory: '4Gi'
    limits:
      memory: '8Gi'
    storageClaims:
      - resources:
          requests:
            storage: 50Gi
        storageClassName: local-path
    config:
      config: |
        [logger]
          level = "info"
        [profiles.default]
          max_memory_usage = 0
      proxy: |
        log-level = "info"
    topologySpreadConstraints:
      - topologyKey: kubernetes.io/hostname
        maxSkew: 1
```

TiFlash 特有の注意点:

- `spec.tiflash.config` は `config` (tiflash 本体) と `proxy` (組み込み TiKV Learner) の 2 サブキーを持つ (`pd` / `tikv` / `tidb` の `config: |` 単一とは書式が違う)
- `storageClaims` は list。TiFlash は data ディレクトリを複数 PV に分散できる設計だが dev では 1 本
- log 出力先はデフォルトで良い (TiKV のような `[log.file]` 明示は不要。DeltaTree エンジンのログは stdout に流れて `kubectl logs` で見える)
- `additionalVolumes` (log emptyDir) は付けない — TiKV は debug 用に `/var/log/tikv` を分けているが TiFlash は使用頻度が低いので割愛

### 1-3. 反映 (ユーザー実行)

```bash
kubectl -n tidb-cluster apply -f cluster/manifests/tidb-cluster/tidb-cluster.yaml
```

Operator が `basic-tiflash-0` StatefulSet を作成し、Pod が起動するのを待つ (5 - 15 分)。

```bash
kubectl -n tidb-cluster get pods -l app.kubernetes.io/component=tiflash -w
# basic-tiflash-0   4/4   Running が出れば OK
```

### 1-4. 動作確認 (ユーザー実行)

TiFlash が Region を認識しているか確認。

```bash
kubectl -n tidb-cluster exec -it basic-pd-0 -- /pd-ctl store
# store.labels に engine=tiflash が付いたノードが 1 つあること
```

MySQL クライアントから `INFORMATION_SCHEMA.tiflash_replica` を叩いて、まだ TiFlash replica を張ったテーブルが無いことを確認 (Phase 3 で articles に張る)。

```bash
mysql -h tidb.${TAILNET} -P 4000 -u root -e \
  "SELECT * FROM INFORMATION_SCHEMA.TIFLASH_REPLICA;"
# → Empty set が出れば正常
```

### Phase 1 完了条件

- [x] `basic-tiflash-0` Pod が `4/4 Running`
- [x] `pd-ctl store` に engine=tiflash が 1 store 見える (store id 7097, state Up, v8.5.7)
- [x] `INFORMATION_SCHEMA.TIFLASH_REPLICA` が空 (テーブル未指定なので正常。TiFlash store の `region_count: 0` からも確認可能)

---

## Phase 2: PLaMo Embedding Service

### 2-1. 設計

PLaMo Embedding 1B (`pfnet/plamo-embedding-1b`, Apache 2.0) は `AutoModel` から `encode_query(text)` / `encode_document(text)` を呼び出すカスタム実装 (sentence-transformers ではない)。したがって **Python FastAPI wrapper を自作** して HTTP エンドポイント化する。

- 依存: `torch` (CPU), `transformers`, `sentencepiece`, `fastapi`, `uvicorn`
- エンドポイント: `POST /embed` — body `{"text": "...", "mode": "query" | "document"}` → `{"vector": [float; N]}`
- モデルは Pod 起動時に 1 回だけ load して常駐 (メモリに乗せる)
- 次元数 (N) は model config で `hidden_size` を確認。plamo-embedding-1b は **2048 次元** と想定 (Phase 3 の DDL 前に model config の実物で必ず再確認する)
- 記事本文 (~数千文字) 1 本の encode は CPU で 100 - 500 ms 程度を想定

### 2-2. ディレクトリ構成

```
cluster/manifests/plamo-embedding/
├── deployment.yaml    # Deployment + Service (ClusterIP)
├── Dockerfile         # (別途 ghcr 等に push する想定なら参考として残す)
└── server.py          # FastAPI + transformers wrapper
```

### 2-3. `server.py`

```python
import os
from fastapi import FastAPI
from pydantic import BaseModel
from transformers import AutoModel, AutoTokenizer
import torch

MODEL_ID = os.environ.get("MODEL_ID", "pfnet/plamo-embedding-1b")
DEVICE = "cpu"

app = FastAPI()
tokenizer = AutoTokenizer.from_pretrained(MODEL_ID, trust_remote_code=True)
model = AutoModel.from_pretrained(MODEL_ID, trust_remote_code=True).to(DEVICE).eval()

class EmbedRequest(BaseModel):
    text: str
    mode: str  # "query" or "document"

class EmbedResponse(BaseModel):
    vector: list[float]
    dim: int

@app.post("/embed", response_model=EmbedResponse)
def embed(req: EmbedRequest) -> EmbedResponse:
    with torch.inference_mode():
        if req.mode == "query":
            vec = model.encode_query(req.text, tokenizer)
        else:
            vec = model.encode_document(req.text, tokenizer)
    vec_list = vec.squeeze(0).cpu().tolist()
    return EmbedResponse(vector=vec_list, dim=len(vec_list))

@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}
```

### 2-4. `Dockerfile`

```dockerfile
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN pip install --no-cache-dir \
      torch==2.5.1 --index-url https://download.pytorch.org/whl/cpu && \
    pip install --no-cache-dir \
      transformers==4.46.0 sentencepiece fastapi uvicorn pydantic

COPY server.py /app/server.py

# ビルド時にモデルを事前 pull しておくと、初回起動を短縮できる
ARG MODEL_ID=pfnet/plamo-embedding-1b
ENV MODEL_ID=${MODEL_ID}
RUN python -c "from transformers import AutoModel, AutoTokenizer; \
  AutoTokenizer.from_pretrained('${MODEL_ID}', trust_remote_code=True); \
  AutoModel.from_pretrained('${MODEL_ID}', trust_remote_code=True)"

EXPOSE 8080
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080"]
```

### 2-5. `deployment.yaml`

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: plamo-embedding
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: plamo-embedding
  namespace: plamo-embedding
spec:
  replicas: 1
  selector:
    matchLabels:
      app: plamo-embedding
  template:
    metadata:
      labels:
        app: plamo-embedding
    spec:
      containers:
        - name: server
          image: ghcr.io/shuntaka9576/plamo-embedding:latest  # 別途 build & push
          ports:
            - containerPort: 8080
          readinessProbe:
            httpGet: { path: /healthz, port: 8080 }
            initialDelaySeconds: 60
            periodSeconds: 10
          resources:
            requests:
              cpu: '500m'
              memory: '6Gi'
            limits:
              memory: '8Gi'
---
apiVersion: v1
kind: Service
metadata:
  name: plamo-embedding
  namespace: plamo-embedding
spec:
  type: ClusterIP
  selector:
    app: plamo-embedding
  ports:
    - port: 80
      targetPort: 8080
```

クラスタ内から `http://plamo-embedding.plamo-embedding.svc.cluster.local/embed` で叩ける。

### 2-6. Image ビルド + push

ghcr など到達可能なレジストリに push する。arm64 対応が必要。

```bash
cd cluster/manifests/plamo-embedding
docker buildx build --platform linux/arm64 \
  -t ghcr.io/shuntaka9576/plamo-embedding:latest --push .
```

### 2-7. 反映 (ユーザー実行)

```bash
kubectl apply -f cluster/manifests/plamo-embedding/deployment.yaml
kubectl -n plamo-embedding get pods -w
```

初回起動時にモデル load が走るため readinessProbe が通るまで 1 - 3 分。

### 2-8. 動作確認 (ユーザー実行)

Tailnet 経由で ClusterIP に到達するには port-forward が手っ取り早い。

```bash
kubectl -n plamo-embedding port-forward svc/plamo-embedding 8080:80 &
curl -s -X POST http://localhost:8080/embed \
  -H 'Content-Type: application/json' \
  -d '{"text":"日本語の検索テスト","mode":"query"}' | jq '.dim'
# → 2048 が返れば OK。異なる値なら Phase 3 の VECTOR(N) を実測値に合わせる
```

### Phase 2 完了条件

- [ ] `plamo-embedding` Pod が Ready
- [ ] `/embed` が 2048 (実測値) 次元の float 配列を返す
- [ ] `dim` を Phase 3 の DDL に反映する値として記録した

---

## Phase 3: `articles.embedding` 列 + HNSW インデックス

### 3-1. DDL ファイル追加

`tools/dsql-cli/dsl-tidb/schema/04_articles.sql` の末尾に、他のマイグレーションと同じ形式で追記する (専用ファイルを切らないのは既存の `content_html` 追加も同ファイル末尾に置いているため)。

```sql
-- 2026-07-15 Vector 検索: articles.embedding + HNSW on TiFlash
-- N は PLaMo Embedding 1B の実測次元 (Phase 2-8 で確認した値)。以下は 2048 を仮定
ALTER TABLE `${SCHEMA}`.`articles`
  ADD COLUMN `embedding` VECTOR(2048) NULL AFTER `content_html`;

-- TiFlash replica を張る (Phase 1 で TiFlash store が起動済みであること)
ALTER TABLE `${SCHEMA}`.`articles` SET TIFLASH REPLICA 1;

-- HNSW インデックスは TiFlash replica の同期完了後に作成される。
-- CREATE VECTOR INDEX 自体はすぐ返り、バックグラウンドで build される。
CREATE VECTOR INDEX `idx_articles_embedding`
  ON `${SCHEMA}`.`articles` ((VEC_COSINE_DISTANCE(`embedding`)))
  USING HNSW;
```

### 3-2. 適用 (ユーザー実行)

```bash
cd tools/dsql-cli/dsl-tidb
./load.sh --database blog_dev --host tidb.${TAILNET}
# schema/*.sql が冪等 (IF NOT EXISTS / ALTER TABLE ADD COLUMN は既適用なら失敗するので、
# 初回のみ通ればよい)
```

冪等でない ALTER 系は再実行するとエラーになる。手動で追加分だけ流したい場合:

```bash
mysql -h tidb.${TAILNET} -P 4000 -u root blog_dev <<'SQL'
ALTER TABLE articles ADD COLUMN embedding VECTOR(2048) NULL AFTER content_html;
ALTER TABLE articles SET TIFLASH REPLICA 1;
CREATE VECTOR INDEX idx_articles_embedding
  ON articles ((VEC_COSINE_DISTANCE(embedding))) USING HNSW;
SQL
```

### 3-3. 動作確認 (ユーザー実行)

TiFlash replica の同期が完了しているか確認。

```bash
mysql -h tidb.${TAILNET} -P 4000 -u root -e "
SELECT TABLE_SCHEMA, TABLE_NAME, REPLICA_COUNT, AVAILABLE, PROGRESS
  FROM INFORMATION_SCHEMA.TIFLASH_REPLICA
 WHERE TABLE_SCHEMA = 'blog_dev' AND TABLE_NAME = 'articles';"
# AVAILABLE = 1, PROGRESS = 1 になれば同期完了 (数分〜十数分)
```

HNSW インデックスの状態確認。

```bash
mysql -h tidb.${TAILNET} -P 4000 -u root -e "SHOW CREATE TABLE blog_dev.articles;"
# 出力に VECTOR INDEX idx_articles_embedding が含まれること
```

### Phase 3 完了条件

- [ ] `articles.embedding` 列が存在 (`DESC blog_dev.articles`)
- [ ] `TIFLASH_REPLICA.AVAILABLE = 1, PROGRESS = 1`
- [ ] `SHOW CREATE TABLE` に `VECTOR INDEX idx_articles_embedding` がある

---

## Phase 4: `tools/tidb-embedder` (既存レコード埋め戻し)

### 4-1. ディレクトリ構成

`tools/content-html-backfill` を参考に、TypeScript + mysql2 で埋め戻す小さな CLI を作る。

```
tools/tidb-embedder/
├── package.json
├── tsconfig.json
└── src/
    └── index.ts
```

### 4-2. `package.json`

```json
{
  "name": "tidb-embedder",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "backfill": "tsx src/index.ts",
    "type-check": "tsc --noEmit"
  },
  "dependencies": {
    "commander": "^15.0.0",
    "mysql2": "^3.23.0"
  }
}
```

### 4-3. `src/index.ts` の骨格

`content-html-backfill/src/index.ts` (WHERE 条件で NULL 対象を絞り込み、slug 単発指定と dry-run に対応するパターン) を踏襲する。差分は以下だけ:

- markdown 変換ロジックの代わりに `fetch(embeddingEndpoint, { body: { text, mode: 'document' } })` を叩く
- `UPDATE ... SET embedding = ?` の bind 値は `[0.1, 0.2, ...]` 形式の文字列 (mysql2 が VECTOR にキャストする)
- `updated_at` を保持したいので、`content_html` と同じく `ON UPDATE` が無いことを利用して `SET embedding = ?` だけ更新する

主要処理:

```typescript
const res = await fetch(`${opts.embedEndpoint}/embed`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: row.content, mode: 'document' }),
});
const { vector } = (await res.json()) as { vector: number[] };
const literal = `[${vector.join(',')}]`;
await conn.execute('UPDATE articles SET embedding = ? WHERE article_id = ?', [
  literal,
  row.article_id,
]);
```

CLI オプション:

```
--endpoint <url>          TiDB (例: mysql://root@tidb.<TAILNET>:4000/blog_dev)
--embed-endpoint <url>    PLaMo (例: http://localhost:8080)
--all                     embedding IS NOT NULL も再生成
--slug <slug>             特定 slug のみ
--dry-run                 UPDATE せず件数と次元だけ表示
```

### 4-4. 実行 (ユーザー実行)

Phase 2 の port-forward を張ったまま実行。

```bash
cd tools/tidb-embedder
bun install
bun run backfill \
  --endpoint "mysql://root@tidb.${TAILNET}:4000/blog_dev" \
  --embed-endpoint "http://localhost:8080" \
  --dry-run
# 対象件数と次元が想定通りなら --dry-run を外して本実行
```

### 4-5. 動作確認 (ユーザー実行)

```bash
mysql -h tidb.${TAILNET} -P 4000 -u root blog_dev -e "
SELECT COUNT(*) FILTER (WHERE embedding IS NOT NULL) AS filled,
       COUNT(*) AS total FROM articles;"
```

サンプル検索:

```bash
# クエリ側 embedding を取得
QVEC=$(curl -s -X POST http://localhost:8080/embed \
  -H 'Content-Type: application/json' \
  -d '{"text":"TiDB の Vector 検索","mode":"query"}' \
  | jq -r '.vector | tostring')

mysql -h tidb.${TAILNET} -P 4000 -u root blog_dev -e "
SELECT article_id, LEFT(title, 40) AS title,
       VEC_COSINE_DISTANCE(embedding, '${QVEC}') AS dist
  FROM articles
 WHERE embedding IS NOT NULL
 ORDER BY dist ASC
 LIMIT 5;"
```

### Phase 4 完了条件

- [ ] 全記事の `embedding` が埋まっている
- [ ] サンプル検索で意味の近い記事が上位に来る (目視)
- [ ] `EXPLAIN` に `IndexRangeScan` (vector) / TiFlash MPP が現れる

---

## Phase 5: `blog-api` 検索エンドポイント

### 5-1. 設計

- ルート: `GET /users/{user_id}/articles/search?q=<query>&limit=20`
- 認証: 既存の users_articles と同じ policy (未認証で公開記事のみ or 認証済みで自分の記事)
- ハンドラフロー:
  1. `q` を PLaMo Embedding Service で vectorize (mode=query)
  2. `VEC_COSINE_DISTANCE(embedding, ?)` で ORDER BY, LIMIT 20
  3. 既存の `ArticleSummary` DTO で返す (title / slug / published_at / dist を含める)

### 5-2. 実装ポイント

- **`infrastructure/src/repository/embedding/`** を新規作成し、`PLAMO_EMBED_ENDPOINT` を環境変数から読んで `reqwest` で `POST /embed` を叩く小さな client を置く (query / document 両方に対応。Phase 7 でも同じものを流用する)
- **`kernel/src/repository/articles.rs`** に `search_by_vector(user_id, vector, limit)` メソッドを追加
- **`adapter/src/repository/articles.rs`** で SQL 実装:
  ```sql
  SELECT article_id, title, slug, description, thumbnail, type, published_at,
         VEC_COSINE_DISTANCE(embedding, ?) AS dist
    FROM articles
   WHERE user_id = ? AND status = 'published' AND embedding IS NOT NULL
   ORDER BY dist ASC
   LIMIT ?
  ```
  - TiFlash MPP に落ちるよう `SET SESSION tidb_isolation_read_engines = 'tiflash,tikv'` の設定が必要かは `EXPLAIN` で確認
- **`api/src/route/users_articles.rs`** に `/search` サブルート追加
- **`api/src/handler/users_articles.rs`** で 5-2 の embedding client を呼ぶ

### 5-3. 動作確認 (ユーザー実行)

```bash
# blog-api ローカル起動 (別ターミナル)
cd apps/blog-api
PLAMO_EMBED_ENDPOINT=http://localhost:8080 \
  DATABASE_URL="mysql://root@tidb.${TAILNET}:4000/blog_dev" \
  cargo run --bin api

# 検索リクエスト
curl -s "http://localhost:3000/users/<user_id>/articles/search?q=TiDB%20Vector" | jq '.'
```

### 5-4. `EXPLAIN` 確認

```sql
EXPLAIN
SELECT article_id, VEC_COSINE_DISTANCE(embedding, '[...]') AS dist
  FROM articles
 WHERE user_id = 'xxx' AND status = 'published'
 ORDER BY dist ASC LIMIT 20;
```

- `TableFullScan` → TiFlash MPP + `Sort` になっていないか (HNSW インデックスが効くと `IndexRangeScan_*` が出るはず)
- 効かない場合: TiFlash replica の同期 (Phase 3) と HNSW build 完了を確認

### Phase 5 完了条件

- [ ] 検索エンドポイントが 200 を返す
- [ ] 上位 20 件が意味的に妥当
- [ ] `EXPLAIN` で HNSW / TiFlash 経路が使われている
- [ ] 未認証で他人の下書きが返らないこと (既存 policy を破っていない)

---

## Phase 6: 本番 (blog_prd) 適用

### 6-1. 事前バックアップ

`docs/source/98_tasks/2026-07-05-tidb-prd-dump/index.md` の手順で `blog_prd` を論理ダンプ。

### 6-2. TiFlash replica (本番)

Phase 1 で cluster レベルの TiFlash 追加は完了しているため、本番でも同じ store を共有できる。追加作業は `blog_prd.articles` へ replica を張るだけ。

```sql
USE blog_prd;
ALTER TABLE articles SET TIFLASH REPLICA 1;
```

`TIFLASH_REPLICA.AVAILABLE = 1` を待つ。

### 6-3. DDL 適用 (本番)

```bash
cd tools/dsql-cli/dsl-tidb
./load.sh --database blog_prd --host tidb.${TAILNET}
```

または追加分だけ手動で:

```bash
mysql -h tidb.${TAILNET} -P 4000 -u root blog_prd <<'SQL'
ALTER TABLE articles ADD COLUMN embedding VECTOR(2048) NULL AFTER content_html;
CREATE VECTOR INDEX idx_articles_embedding
  ON articles ((VEC_COSINE_DISTANCE(embedding))) USING HNSW;
SQL
```

### 6-4. 埋め戻し (本番)

ユーザーが手元から実行 (Tailnet 経由で prd DB と PLaMo Pod の両方に到達可能)。

```bash
kubectl -n plamo-embedding port-forward svc/plamo-embedding 8080:80 &
cd tools/tidb-embedder
bun run backfill \
  --endpoint "mysql://root@tidb.${TAILNET}:4000/blog_prd" \
  --embed-endpoint "http://localhost:8080" \
  --dry-run
# 件数確認後に --dry-run を外して本実行
```

### 6-5. 本番 blog-api への検索 API 公開 (到達性の課題)

本番 blog-api は AWS Lambda 上で動き、TiDB へは `tidb-proxy` (ECS Fargate + Tailscale tsnet) 経由で TCP 中継している。PLaMo Embedding Service (HTTP) は現状同じルートを通せない。

**方針候補 (別タスク検討)**:

1. `tidb-proxy` に L4 で PLaMo Service 用の中継ポートを追加する
2. Lambda 用の HTTP プロキシを新設する (squid 側で許可 URL を絞る)
3. 検索エンドポイントを **Tailnet 内 (cluster 内) の別サービス** として立てる (Lambda を経由しない)

いずれも本タスクの範囲外。**本番の検索 API 公開は保留** し、6-4 の埋め戻しまでで一旦切る。

### Phase 6 完了条件

- [ ] `blog_prd.articles.embedding` が全記事埋まっている
- [ ] `TIFLASH_REPLICA.AVAILABLE = 1` for `blog_prd.articles`
- [ ] 本番検索 API 公開の別タスクを起票した (6-5 の到達性設計)

---

## Phase 7: GitHub webhook 経路への embedding 生成組み込み (継続更新)

Phase 4 のローカルバックフィルは「その時点で `embedding IS NULL` の行を埋める」だけ。以降の記事追加・更新は再度手で `tidb-embedder` を回す運用になる。それを webhook 契機で自動化するのが本フェーズ。

### 7-1. 変更方針

`apps/blog-api/api/src/handler/webhooks.rs` は `content_html` を「content が変わったとき」に生成している。同じロジックで `embedding` も生成する。

- content 変更検知は既存の `needs_html` 判定を流用 (`markdown_content` が更新される条件と同じ)
- 埋め込みは Phase 5-2 で作った embedding client (`reqwest`) を再利用
- 本番の到達性 (Phase 6-5) が解決していない間は、環境変数 `PLAMO_EMBED_ENDPOINT` が未設定なら生成をスキップする実装にしておく (dev のみ有効化)

### 7-2. `adapter/src/repository/articles.rs` の SQL 修正

`upsert_from_webhook` の UPDATE 文に `embedding = COALESCE(?, embedding)` を追加。バインドを 1 つ増やす (VECTOR は `[..]` 形式の文字列で bind)。

### 7-3. `handler/webhooks.rs` の修正

`content_html` 生成の直後に、同じ `needs_html` 判定を使って embedding を生成する分岐を追加。PLaMo endpoint 未設定または呼び出し失敗はログに出して None を渡す (embedding 未反映で記事だけ更新される安全側フォールバック)。

### 7-4. 動作確認

- ローカルで `PLAMO_EMBED_ENDPOINT=http://localhost:8080` を渡して webhook を再送
- 対象記事の `content` を変更したコミットで `embedding` も更新されること
- endpoint 未設定でも記事更新自体は成功すること

### Phase 7 完了条件

- [ ] webhook で content が変わった記事は embedding も更新される (dev)
- [ ] PLaMo endpoint 未設定 / 呼び出し失敗でも記事更新自体は成功する
- [ ] `updated_at` は他フィールドの更新条件でのみ変わる (embedding だけの UPDATE は起こさない — content_html と同じ扱い)

---

## 作業ログ

### 2026-07-15

- タスク doc 起票、Phase 1 の manifest 編集まで実施
- Phase 1 実施完了。`kubectl apply` 後、`basic-tiflash-0` が Up (store id 7097)、`pd-ctl store` で engine=tiflash 1 store 確認
