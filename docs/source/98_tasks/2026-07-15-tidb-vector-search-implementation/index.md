<!-- cspell:ignore fastapi huggingface pretrained pydantic QVEC sentencepiece uvicorn -->

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
- [x] Phase 2: PLaMo Embedding Service (k8s Pod + HTTP wrapper) — 2026-07-15 完了
- [x] Phase 3: `articles.embedding` 列 + TiFlash replica追加 (DDL) — 2026-07-15 完了
- [ ] Phase 4: `tools/tidb-embedder` で埋め戻し後に HNSW インデックス作成
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

| フェーズ                               | 目安時間                    |
| -------------------------------------- | --------------------------- |
| Phase 1: TiFlash 追加                  | 10 - 20 分                  |
| Phase 2: PLaMo Embedding Service       | 30 - 60 分 (初回 pull 込み) |
| Phase 3: DDL 適用                      | 5 分                        |
| Phase 4: tidb-embedder 実装 + 埋め戻し | 60 分 + データ量依存        |
| Phase 5: 検索エンドポイント            | 60 - 120 分                 |
| Phase 6: 本番適用                      | 30 分                       |
| Phase 7: webhook 組み込み (継続更新)   | 30 分                       |

---

## Phase 1: TiFlash 追加

### 1-1. 前提確認

TiFlash は各 k8s ノードのローカルディスクに DeltaTree ストレージを持つ。dev では 1 replica で十分。

- ノードに空きストレージがあること (`local-path` provisioner の PV が確保できる領域)
- 記事データは 2.5MB 程度と小さいので 20Gi あれば十分だが、将来の拡張を見越して **50Gi** で確保する
- MiniPC は Ryzen 7 7730U (**amd64**) なので `pingcap/tiflash:v8.5.7` の amd64 manifest が pull される

```bash
kubectl -n tidb-cluster get tc basic -o jsonpath='{.spec.version}'
# → v8.5.7 が出ればよい

kubectl get nodes -o custom-columns=NAME:.metadata.name,ARCH:.status.nodeInfo.architecture
# → amd64 が並ぶこと (MiniPC = Ryzen 7 7730U)
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
- 次元数 (N) は `/embed` の query / document 両モードで **2048 次元** と実測済み
- 記事本文 (~数千文字) 1 本の encode は CPU で 100 - 500 ms 程度を想定

### 2-2. ディレクトリ構成 (実装済み)

```
cluster/manifests/plamo-embedding/
├── server.py          # FastAPI + transformers wrapper
├── Dockerfile         # linux/amd64, model を build 時に焼き込み
├── deployment.yaml    # Namespace + Deployment (2 replicas) + Service (ClusterIP)
└── build-and-push.sh  # ローカル build & ghcr push
```

実体は [`cluster/manifests/plamo-embedding/`](../../../../cluster/manifests/plamo-embedding/) を参照。

### 2-3. 設計メモ

- **model 事前焼き込み**: Dockerfile の build 時に HuggingFace から model を pull し image に含める。image サイズは ~5GB になるが、Pod 起動時のダウンロード時間 / ネットワーク依存を消せる (registry pull は node ごとに 1 回で済む)
- **`snapshot_download` を使う理由**: 素直に `AutoModel.from_pretrained()` で pre-warm すると model を RAM に全展開して verify するため、Docker Desktop 既定メモリ (2-4GB) を超えて OOM (`Killed`, `cannot allocate memory`) になる。`huggingface_hub.snapshot_download` はファイル DL のみで RAM を使わないので build が通る。runtime の `AutoModel.from_pretrained()` は HF cache から読むので network 不要のまま
- **CPU 版 torch**: `--index-url https://download.pytorch.org/whl/cpu` で fetch。amd64 wheel が公式提供されている (target が Ryzen MiniPC = amd64)
- **2 replicas**: node1 は TiFlash 用に空け、node2 / node3 へ PLaMo を1 Podずつ配置する。`podAntiAffinity` で同居を禁止する
- **Deployment strategy: RollingUpdate**: `maxSurge: 0`, `maxUnavailable: 1` とし、更新中に追加 Pod を作らずモデル分のメモリ増加を防ぐ
- **Tailnet 公開**: `cluster/manifests/tailscale/plamo-embedding-public.yaml` で `plamo-embedding.<tailnet>` をServiceへ接続する。`port-forward svc/...` は1 Podへ直接転送されるため、複数Podへの分散には使わない
- **依存バージョン (Dockerfile)**: `torch==2.5.1`, `transformers==4.46.0`, `sentencepiece==0.2.0`, `fastapi==0.115.4`, `uvicorn==0.32.0`, `pydantic==2.9.2` を pin
- **`--provenance=false --sbom=false` (build-and-push.sh)**: buildx はデフォルトで OCI index に attestation manifest を追加するが、k3s/MiniPC の古めの containerd がそれで `no match for platform in manifest` と誤判定して pull に失敗する (`ImagePullBackOff`)。attestation を切ることで single-platform manifest だけになり pull が通る

### 2-4. ghcr ログイン (初回のみ、ユーザー実行)

ghcr.io は Docker のパスワード認証を受け付けない (MFA の有無に関わらず PAT 必須)。既存の `gh` CLI 認証に `write:packages` / `read:packages` を後付けして、`gh auth token` の出力で docker login するのが最短。

```bash
# 現状の scope 確認 (write:packages が無ければ次のコマンドで追加)
gh auth status

# scope を後付け (ブラウザで one-time code の入力を求められる)
gh auth refresh --scopes write:packages,read:packages

# gh のトークンで ghcr にログイン
gh auth token | docker login ghcr.io -u shuntaka9576 --password-stdin
# → "Login Succeeded" が出れば OK
```

**トラブルシュート**: `docker login ghcr.io` で対話的に password を入力すると `denied: denied` になる。これは GitHub の web パスワードを渡しているため。必ず PAT (もしくは `gh auth token` の出力) を stdin から渡すこと。

### 2-5. Image ビルド + push (ユーザー実行)

Apple Silicon Mac (native arm64) から実行するのが速い。

```bash
cd cluster/manifests/plamo-embedding
./build-and-push.sh
# → ghcr.io/shuntaka9576/plamo-embedding:latest を build & push
# タグを分けたい場合: TAG=2026-07-15 ./build-and-push.sh
```

初回 build は torch install + model download で 10-20 分程度。

**なぜ workflow_dispatch action ではないか**: PLaMo image は「Python deps か server.py を変えるまで更新しない」性質で、更新頻度が低い。`deploy-tidb-proxy.yaml` のような頻繁な更新は想定しないため、まずローカルスクリプトで済ませる。更新頻度が上がってきたら (~ 月次) workflow 化を検討する。

### 2-6. Package を public 化 (初回のみ、ユーザー実行)

ghcr は **push した package が必ず private で作成される** (リポジトリが public でも独立)。private のままだと kubelet が pull できず `ErrImagePull` になる。無料運用のため public に切り替える。

**個人アカウントの package visibility は REST API から変更できない** (org packages 用の PATCH はあるが user packages 側は 404)。Web UI からのみ操作可能。

```bash
open "https://github.com/users/shuntaka9576/packages/container/plamo-embedding/settings"
```

ページ末尾 **Danger Zone** → **"Change package visibility"** → **Public** → package name (`plamo-embedding`) を入力して確定。

確認 (API では visibility 取得は可能):

```bash
gh api /user/packages/container/plamo-embedding | jq '.visibility'
# → "public"
```

一度 public 化すれば同名 package への以降の push でも visibility は維持される。**将来別 image (例: `tidb-embedder`) を追加する場合はそれぞれ改めて public 化が必要**。

### 2-7. 反映 (ユーザー実行)

```bash
kubectl apply -f cluster/manifests/plamo-embedding/deployment.yaml
kubectl apply -f cluster/manifests/tailscale/plamo-embedding-public.yaml
kubectl -n plamo-embedding get pods -w
# node2 / node3 の2 Podが Running / READY 1/1 になるまで待つ
```

### 2-8. 動作確認 (ユーザー実行)

Tailnet公開Serviceへ接続する。

```bash
curl -s -X POST http://plamo-embedding.${TAILNET}/embed \
  -H 'Content-Type: application/json' \
  -d '{"text":"日本語の検索テスト","mode":"query"}' | jq '.dim'
# → 2048 が返れば OK。異なる値なら Phase 3 の VECTOR(N) を実測値に合わせる
```

`document` モードも一応叩いておく:

```bash
curl -s -X POST http://plamo-embedding.${TAILNET}/embed \
  -H 'Content-Type: application/json' \
  -d '{"text":"これは記事本文の例です","mode":"document"}' | jq '{dim, head: .vector[0:3]}'
```

### Phase 2 完了条件

- [x] `plamo-embedding` Pod が Ready
- [x] `/embed` (query / document 両方) が 2048 (実測値) 次元の float 配列を返す
- [x] `dim = 2048` を Phase 3 の DDL に反映する値として記録した

---

## Phase 3: `articles.embedding` 列 + TiFlash replica

### 3-1. DDL ファイル追加 (実装済み)

`tools/dsql-cli/dsl-tidb/schema/04_articles.sql` の末尾に、他のマイグレーションと同じ形式で追記する (専用ファイルを切らないのは既存の `content_html` 追加も同ファイル末尾に置いているため)。

```sql
-- 2026-07-15 Vector 検索: articles.embedding + TiFlash replica
-- N は PLaMo Embedding 1B の実測次元 (Phase 2-8 で確認した値 = 2048)
ALTER TABLE `${SCHEMA}`.`articles`
  ADD COLUMN `embedding` VECTOR(2048) NULL AFTER `content_html`;

-- TiFlash replica を張る (Phase 1 で TiFlash store が起動済みであること)
ALTER TABLE `${SCHEMA}`.`articles` SET TIFLASH REPLICA 1;

-- HNSW index は embedding の backfill と TiFlash COMPACT の完了後に作成する。
```

### 3-2. 適用 (ユーザー実行)

`load.sh` は差分マイグレーションではなく、`schema/*.sql` を先頭から実行する初期構築用スクリプトである。既存の `blog_dev` では、適用済みのカラムやインデックスを再追加しようとしてエラーになるため、今回は新しい2文だけを実行する。

```bash
mysql -h tidb.${TAILNET} -P 4000 -u root blog_dev <<'SQL'
ALTER TABLE articles ADD COLUMN embedding VECTOR(2048) NULL AFTER content_html;
ALTER TABLE articles SET TIFLASH REPLICA 1;
SQL
```

新規環境をゼロから構築する場合は `04_articles.sql` の一部として適用されるため、通常どおり `load.sh` を使用する。

```bash
cd tools/dsql-cli/dsl-tidb
./load.sh --database blog_dev --host tidb.${TAILNET}
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

### Phase 3 完了条件

- [x] `articles.embedding` 列が `vector(2048)` で存在
- [x] `TIFLASH_REPLICA.AVAILABLE = 1, PROGRESS = 1`

### 3-4. HNSW先行作成によるTiFlashクラッシュと復旧 (2026-07-15)

初回は全133記事の `embedding` が NULL の状態で HNSW index を作成した。その後、TiFlash v8.5.7 が `DMFileVectorIndexWriter` で既存DMFileのindexを構築する際、checksum frame size 0を除算して `Floating point exception` (exit 136) でCrashLoopした。

```text
EnsureStableLocalIndex - Begin building index
Received signal Floating point exception(8).
Integer divide by zero.
FramedChecksumReadBuffer<XXH3>::doSeek
DMFileVectorIndexWriter::buildIndexForFile
```

TiDB側のindex定義はdrop済みだが、TiFlashはPVC上に残った古いlocal-index taskをschema同期より先に再開し、同じクラッシュを繰り返した。`SHOW CREATE TABLE` にindexがないことを確認してから、一度TiFlash replicaを0にしてlocal replicaを切り離す。以下はユーザーが実行する。

```bash
mysql -h tidb.${TAILNET} -P 4000 -u root -e \
  "SHOW CREATE TABLE blog_dev.articles\G"
# idx_articles_embedding がないこと

mysql -h tidb.${TAILNET} -P 4000 -u root blog_dev -e \
  "ALTER TABLE articles SET TIFLASH REPLICA 0;"

mysql -h tidb.${TAILNET} -P 4000 -u root -e "
SELECT * FROM INFORMATION_SCHEMA.TIFLASH_REPLICA
 WHERE TABLE_SCHEMA = 'blog_dev' AND TABLE_NAME = 'articles';"
# 0 rowsになること

# CrashLoopのbackoffを待たず、replica=0の最新schemaで起動し直す
kubectl -n tidb-cluster delete pod basic-tiflash-0

kubectl -n tidb-cluster get pods -l app.kubernetes.io/component=tiflash -w
# basic-tiflash-0 が 4/4 Running に戻ること
```

[TiDB公式のTiFlash replica作成手順](https://docs.pingcap.com/tidb/stable/create-tiflash-replicas/)でも `SET TIFLASH REPLICA 0` はreplicaの削除を意味する。これだけで復旧しない場合は、壊れた分析用replicaのPVCを再作成する。元データはTiKVにあるため、backfill後にreplicaを1へ戻すと再同期される。

```bash
# TiFlashだけを停止する (TiDB / TiKVには影響しない)
kubectl -n tidb-cluster patch tidbcluster basic --type merge \
  -p '{"spec":{"tiflash":{"replicas":0}}}'
kubectl -n tidb-cluster wait --for=delete pod/basic-tiflash-0 --timeout=5m

# 現在の分析用replica PVCだけを削除する。Retainのままだと実データが残るためDeleteへ変更する
PV=$(kubectl -n tidb-cluster get pvc data0-basic-tiflash-0 \
  -o jsonpath='{.spec.volumeName}')
kubectl patch pv "${PV}" --type merge \
  -p '{"spec":{"persistentVolumeReclaimPolicy":"Delete"}}'
kubectl -n tidb-cluster delete pvc data0-basic-tiflash-0
kubectl wait --for=delete "pv/${PV}" --timeout=5m

# source manifestと同じ1 replicaへ戻す
kubectl -n tidb-cluster patch tidbcluster basic --type merge \
  -p '{"spec":{"tiflash":{"replicas":1}}}'
kubectl -n tidb-cluster get pods -l app.kubernetes.io/component=tiflash -w
# 新しいbasic-tiflash-0が4/4 Runningになること
```

HNSW indexはPhase 4でbackfill、TiFlash replica再同期、compactionが完了した後に作成する。`04_articles.sql` にもindex作成を含めない。

---

## Phase 4: `tools/tidb-embedder` (既存レコード埋め戻し + HNSW作成)

### 4-1. ディレクトリ構成 (実装済み)

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

### 4-3. `src/index.ts` の実装

`content-html-backfill/src/index.ts` (WHERE 条件で NULL 対象を絞り込み、slug 単発指定と dry-run に対応するパターン) を踏襲する。差分は以下だけ:

- markdown 変換ロジックの代わりに `fetch(embeddingEndpoint, { body: { text, mode: 'document' } })` を叩く
- `UPDATE ... SET embedding = ?` の bind 値は `[0.1, 0.2, ...]` 形式の文字列 (mysql2 が VECTOR にキャストする)
- `updated_at` を保持したいので、`content_html` と同じく `ON UPDATE` が無いことを利用して `SET embedding = ?` だけ更新する
- API 応答の `dim`、vector 長、全要素が有限値であることを検証し、2048 次元以外は更新しない
- `--all` を付けない更新には `AND embedding IS NULL` を付け、同時実行で埋められた値を上書きしない
- `--concurrency` で指定したworker数で処理し、1件が失敗しても残りを続行したうえで、失敗があれば終了コードを非0にする

主要処理:

```typescript
const res = await fetch(`${opts.embedEndpoint}/embed`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Connection: 'close' },
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
--embed-endpoint <url>    PLaMo (例: http://plamo-embedding.<TAILNET>)
--all                     embedding IS NOT NULL も再生成
--slug <slug>             特定 slug のみ
--dry-run                 UPDATE せず件数と次元だけ表示
--concurrency <n>         embedding API への同時リクエスト数 (default: 1、2 Pod時は2)
--timeout <ms>            1記事あたりの embedding API timeout (default: 120000)
```

### 4-4. 実行 (ユーザー実行)

Tailnet公開Service経由でnode2/node3の2 Podへ分散する。`kubectl port-forward svc/...` は1 Podへ直接転送されるため使用しない。

```bash
cd tools/tidb-embedder
bun install
bun run backfill \
  --endpoint "mysql://root@tidb.${TAILNET}:4000/blog_dev" \
  --embed-endpoint "http://plamo-embedding.${TAILNET}" \
  --concurrency 2 \
  --dry-run
# 対象件数と次元が想定通りなら --dry-run を外して本実行
```

PLaMo は1リクエストでも約14/16 logical CPUを使用した。2 Podに対して `--concurrency 2` (1 Podあたり1リクエスト目安) とし、それ以上はCPU oversubscriptionで逆に遅くなるため増やさない。CLIはリクエストごとにHTTP connectionを閉じ、Kubernetes Serviceがconnection単位でnode2/node3へ振り分けられるようにする。

### 4-5. 動作確認 (ユーザー実行)

```bash
mysql -h tidb.${TAILNET} -P 4000 -u root blog_dev -e "
SELECT SUM(embedding IS NOT NULL) AS filled,
       COUNT(*) AS total FROM articles;"
```

`filled = total` を確認した後、復旧時に0へ変更したTiFlash replicaを1へ戻して再同期を待つ。全NULLの旧DMFileを残さないようTiFlashをcompactしてからHNSW indexを作成する。

```bash
mysql -h tidb.${TAILNET} -P 4000 -u root blog_dev -e \
  "ALTER TABLE articles SET TIFLASH REPLICA 1;"

mysql -h tidb.${TAILNET} -P 4000 -u root -e "
SELECT TABLE_SCHEMA, TABLE_NAME, REPLICA_COUNT, AVAILABLE, PROGRESS
  FROM INFORMATION_SCHEMA.TIFLASH_REPLICA
 WHERE TABLE_SCHEMA = 'blog_dev' AND TABLE_NAME = 'articles';"
# AVAILABLE = 1, PROGRESS = 1 まで待つ

mysql -h tidb.${TAILNET} -P 4000 -u root blog_dev <<'SQL'
ALTER TABLE articles COMPACT;
CREATE VECTOR INDEX idx_articles_embedding
  ON articles ((VEC_COSINE_DISTANCE(embedding))) USING HNSW;
SQL
```

index buildの進捗を確認する。`ROWS_STABLE_NOT_INDEXED = 0` で完了。

```bash
mysql -h tidb.${TAILNET} -P 4000 -u root -e "
SELECT TIDB_DATABASE, TIDB_TABLE, INDEX_NAME,
       ROWS_STABLE_INDEXED, ROWS_STABLE_NOT_INDEXED,
       ROWS_DELTA_INDEXED, ROWS_DELTA_NOT_INDEXED, ERROR_MESSAGE
  FROM INFORMATION_SCHEMA.TIFLASH_INDEXES
 WHERE TIDB_DATABASE = 'blog_dev' AND TIDB_TABLE = 'articles';"
```

サンプル検索:

```bash
# クエリ側 embedding を取得
QVEC=$(curl -s -X POST http://plamo-embedding.${TAILNET}/embed \
  -H 'Content-Type: application/json' \
  -d '{"text":"TiDB の Vector 検索","mode":"query"}' \
  | jq -c '.vector')

mysql -h tidb.${TAILNET} -P 4000 -u root blog_dev -e "
SELECT article_id, LEFT(title, 40) AS title,
       VEC_COSINE_DISTANCE(embedding, '${QVEC}') AS dist
  FROM articles
 ORDER BY dist ASC
 LIMIT 5;"
```

HNSW index が使われると、`TableFullScan` の `operator info` に `annIndex:COSINE` が表示される。

```bash
mysql -h tidb.${TAILNET} -P 4000 -u root blog_dev -e "
EXPLAIN
SELECT article_id, VEC_COSINE_DISTANCE(embedding, '${QVEC}') AS dist
  FROM articles
 ORDER BY dist ASC
 LIMIT 5;"
```

### Phase 4 完了条件

- [ ] 全記事の `embedding` が埋まっている
- [ ] TiFlashが `4/4 Running` のままHNSW buildを完了し、`ROWS_STABLE_NOT_INDEXED = 0`
- [ ] サンプル検索で意味の近い記事が上位に来る (目視)
- [ ] `EXPLAIN` の `operator info` に `annIndex:COSINE` が現れる

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
PLAMO_EMBED_ENDPOINT=http://plamo-embedding.${TAILNET} \
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

- `TableFullScan` の `operator info` に `annIndex:COSINE` があること (HNSW index利用時もexecutor名は `TableFullScan`)
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
SQL
```

### 6-4. 埋め戻し (本番)

ユーザーが手元から実行 (Tailnet 経由で prd DB と PLaMo Pod の両方に到達可能)。

```bash
cd tools/tidb-embedder
bun run backfill \
  --endpoint "mysql://root@tidb.${TAILNET}:4000/blog_prd" \
  --embed-endpoint "http://plamo-embedding.${TAILNET}" \
  --concurrency 2 \
  --dry-run
# 件数確認後に --dry-run を外して本実行
```

全記事のbackfill完了後にcompactとHNSW index作成を行う。

```bash
mysql -h tidb.${TAILNET} -P 4000 -u root blog_prd <<'SQL'
ALTER TABLE articles COMPACT;
CREATE VECTOR INDEX idx_articles_embedding
  ON articles ((VEC_COSINE_DISTANCE(embedding))) USING HNSW;
SQL
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
- [ ] `idx_articles_embedding` の `ROWS_STABLE_NOT_INDEXED = 0`
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

- ローカルで `PLAMO_EMBED_ENDPOINT=http://plamo-embedding.${TAILNET}` を渡して webhook を再送
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
- Phase 4 dry-run中のクラスタ負荷を確認。node3のPLaMoが約14.1/16 CPUを使用する一方、node1/node2は各約0.2 CPU、available memoryは各ノード約21〜24GiBあり、node2/node3の2 Pod分散を採用
- `kubectl port-forward svc/plamo-embedding` は1 Podへ直接転送されるため、Tailnet LoadBalancer Service (`plamo-embedding.<tailnet>`) 経由へ変更
- TiFlashが `3/4 CrashLoopBackOff` になっていることを検出。全133記事のembeddingがNULLの状態でHNSWを先行作成した結果、`DMFileVectorIndexWriter` → `FramedChecksumReadBuffer::doSeek` でframe size 0の除算が発生 (exit 136)
- TiDB側でindexをdropした後も、TiFlashはPVC上の古いlocal-index taskを起動直後に再開してCrashLoopを継続。replicaを0へ切り替え、必要時は分析用PVCを再作成する復旧手順を3-4へ記録
- HNSW作成をPhase 4のbackfill + TiFlash replica再同期 + `ALTER TABLE articles COMPACT` 後へ移動
