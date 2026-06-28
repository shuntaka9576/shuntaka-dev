# DSQL → TiDB 移行

- 起票日: 2026-06-26
- 移行元: AWS DSQL（PostgreSQL 15.15 互換）
- 移行先: TiDB（Self-hosted, Docker / Kubernetes）
- ステータス: 計画策定済み

## 概要

ブログ基盤の主データベースを AWS DSQL から TiDB（Self-hosted）に切り替える。
移行方針はユーザー指定の以下 2 ステップを基本とする。

1. `dsql-cli` で TSV 形式のバックアップを取得
2. TiDB に `LOAD DATA LOCAL INFILE` で投入

加えてスキーマ DDL の変換、`apps/blog-api` の sqlx ドライバ切替、`iac/aws`（CDK）からの DSQL 撤去まで一連で進める。

## 移行方針

```
+------------+   SELECT * (paged)      +-----------+   LOAD DATA LOCAL INFILE   +------+
| AWS DSQL   | ----------------------> | TSV files | -------------------------> | TiDB |
+------------+   (dsql-cli export)     +-----------+   (dsl-tidb/load.sh)       +------+
```

- DSQL は `COPY ... TO STDOUT` を公式サポートしていない（ロード方向の `\copy FROM` のみ言及あり）ため、`SELECT *` を主キー順にページングして TSV に整形する
- バックアップは `app.users` → `app.tags` → `app.articles` → `app.articles_tags` の順で取得・投入する
- 出力フォーマットは PostgreSQL 標準の `COPY ... TO STDOUT WITH (FORMAT text)` と互換の TSV（タブ区切り、NULL は `\N`、`\t \n \r \\` を PG 標準エスケープ）を自前で生成
- MySQL/TiDB の `LOAD DATA` は同じ `\N` を NULL として解釈するため、NULL 表現の変換は不要

## 互換性差分

| 既存 (DSQL / PostgreSQL)                             | TiDB / MySQL                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------- |
| `UUID PRIMARY KEY DEFAULT gen_random_uuid()`         | `CHAR(36) NOT NULL DEFAULT (UUID()) PRIMARY KEY`                    |
| `TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP` | `DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)`（UTC 固定運用） |
| `CHECK (status IN ('draft', ...))`                   | TiDB 7.x の `CHECK` 互換構文でそのまま                              |
| スキーマ修飾 `app.<table>`                           | TiDB は `database.table` として等価                                 |
| バインドパラメータ `$1, $2, ...`                     | `?`                                                                 |

## タスク1: dsql-cli export サブコマンド追加

### 設計

- 修正ファイル: `tools/dsql-cli/src/index.ts`
- 既存の `connectDsql()` / `isPostgresUrl()` を流用
- DSQL は `COPY ... TO STDOUT` 非対応のため、`SELECT *` を主キー順にページング（`WHERE pk > $1 ORDER BY pk LIMIT $2`）で取得し、PG TEXT フォーマット互換の TSV に整形して書き出す
- DSQL の接続タイムアウト（1 時間）と OCC を考慮し、ページサイズはデフォルト 1000 行・必要に応じて調整可能にする
- CLI オプション: `-e/--endpoint`（環境変数 `DSQL_CLUSTER_ENDPOINT` をデフォルト）, `-o/--out-dir`（デフォルト `backup/`）, `--page-size`（デフォルト 1000）

### チェックリスト

- [x] PG TEXT フォーマット互換のエスケープ処理（`\` → `\\`、TAB → `\t`、LF → `\n`、CR → `\r`、NULL → `\N`）をユーティリティ化
- [x] `SELECT * + 主キーページング` で TSV を生成する `export` サブコマンドを実装
- [x] `package.json` の `scripts` に `"export": "tsx src/index.ts export"` を追加
- [ ] 4 テーブル分の TSV が生成され、行数が `SELECT count(*)` と一致することを確認（dev 環境で実施）
- [x] TiDB に `LOAD DATA LOCAL INFILE` で投入し、NULL を含むカラムが正しく復元されることを確認（手作り fixture で検証済み）

### 実装記録

- `tools/dsql-cli/src/export.ts` を新規追加。`information_schema.columns` / `key_column_usage` からカラム順と主キーを取得し、各カラムを `(col)::text` または `to_char(col AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')` でキャストして取得。
- 主キーページングは `WHERE pk > $1::<pk_type>` (複合キーは行値比較 `WHERE (a,b) > ($1::ta,$2::tb)`) を採用。`uuid` / `bigint` / `timestamptz` 等の元型を維持してインデックスを効かせる。
- `tools/dsql-cli/src/index.ts` に `export` サブコマンドを追加し、`package.json` の `scripts.export` も追加。
- 接続初期化時に `SET TIME ZONE 'UTC'` を発行し、`to_char` の出力が UTC 基準になるようにする。

## タスク2: TiDB 用 DDL 整備と LOAD DATA 投入手順

### 設計

- 新規ディレクトリ `tools/dsql-cli/dsl-tidb/`（既存 `dsl/` は改変しない）
- LOAD DATA は `LOAD DATA LOCAL INFILE` を採用（Self-hosted 前提）

### チェックリスト

- [x] `dsl-tidb/schema/01_schema.sql`（`CREATE DATABASE IF NOT EXISTS \`${SCHEMA}\``）
- [x] `dsl-tidb/schema/02_users.sql`
- [x] `dsl-tidb/schema/03_tags.sql`
- [x] `dsl-tidb/schema/04_articles.sql`
- [x] `dsl-tidb/schema/05_articles_tags.sql`
- [x] `dsl-tidb/load/0{2..5}_*.sql`（テーブルごとの `LOAD DATA LOCAL INFILE` + `SHOW WARNINGS`）
- [x] `dsl-tidb/load.sh` で `${SCHEMA}` / `${TSV}` を sed 置換しつつ DDL → LOAD DATA を順次実行
- [x] TiDB (`blog_dev`) で warning 0、`SELECT COUNT(*)` 一致を確認（手作り fixture: users 2 / tags 2 / articles 2 / articles_tags 3）
- [ ] dev 環境の実データで `SELECT COUNT(*)` が DSQL と一致

### LOAD DATA クエリ例（テンプレート: `${SCHEMA}` / `${TSV}` を load.sh が置換）

```sql
SET time_zone = '+00:00';

LOAD DATA LOCAL INFILE '${TSV}'
INTO TABLE `${SCHEMA}`.`users`
CHARACTER SET utf8mb4
FIELDS TERMINATED BY '\t' ESCAPED BY '\\'
LINES TERMINATED BY '\n'
(`user_id`, `name`, `email`, @github_installation_id, @created_at, @updated_at)
SET
  `github_installation_id` = NULLIF(@github_installation_id, '\\N'),
  `created_at`             = NULLIF(@created_at, '\\N'),
  `updated_at`             = NULLIF(@updated_at, '\\N');

SHOW WARNINGS;
```

### 実装記録

- ディレクトリ構成

  ```
  tools/dsql-cli/dsl-tidb/
  ├── schema/        # CREATE DATABASE / CREATE TABLE (${SCHEMA} 注入)
  │   ├── 01_schema.sql
  │   ├── 02_users.sql
  │   ├── 03_tags.sql
  │   ├── 04_articles.sql
  │   └── 05_articles_tags.sql
  ├── load/          # 各テーブルの LOAD DATA + SHOW WARNINGS (${SCHEMA}/${TSV} 注入)
  │   ├── 02_users.sql
  │   ├── 03_tags.sql
  │   ├── 04_articles.sql
  │   └── 05_articles_tags.sql
  └── load.sh        # CLI ラッパ
  ```

- `${SCHEMA}` を sed で `--database` 引数に置換するため、`blog_dev` / `blog_prod` 等を切り替えて同じ DSL を再利用できる。
- 各 LOAD DATA は `LOAD DATA LOCAL INFILE` を使うため、`mysql --local-infile=1` で接続する。サーバー側にも `local_infile=1` が必要（TiDB 既定で ON、`SELECT @@local_infile` で確認可）。
- TiDB は `tidb_enable_check_constraint` が既定 OFF で、CHECK 句を含む CREATE TABLE は `Warning 1105: the switch of check constraint is off` を出す。warning 0 が要件のため `04_articles.sql` から CHECK を外し、status のバリデーションはアプリ層 (blog-api) で行う方針とした。クラスタ単位で有効化する場合は管理者が `SET GLOBAL tidb_enable_check_constraint = ON;` を実施したうえで ALTER TABLE で CHECK を追加する。
- PG TEXT 形式 (`\N`, `\t`, `\n`, `\r`, `\\`) と MySQL `FIELDS ESCAPED BY '\\'` は相互運用可能。SET 句で `@var` 受けにしたカラムだけは `\N` が文字列のまま入るため `NULLIF(@var, '\N')` を明示する。

### 開発環境での実行手順（dev）

前提:

- TiDB は Tailnet 上のホスト `tidb.<TAILNET>` で 4000/tcp listen
- ローカル PostgreSQL は `docker compose up -d postgres` で起動 (5433 を listen、`db.yml` 参照)
- マイグレーションは `bun run migrate --endpoint postgresql://postgres:postgres@localhost:5433/postgres`

```bash
# 0) Tailnet を環境変数化（生のホスト名は手順に書かない）
export TAILNET=$(tailscale status --json | jq -r '.MagicDNSSuffix')
echo "TAILNET=$TAILNET"

# 1) ローカル PG -> TSV
cd tools/dsql-cli
bun run export \
  --endpoint postgresql://postgres:postgres@localhost:5433/postgres \
  --out-dir ./backup

# 生成物の確認
ls -la backup/
#   app.users.tsv  app.tags.tsv  app.articles.tsv  app.articles_tags.tsv

# 2) TiDB blog_dev に投入（DDL→LOAD DATA→SHOW WARNINGS→SELECT COUNT(*)）
bash dsl-tidb/load.sh \
  --database blog_dev \
  --tsv-dir ./backup \
  --host tidb.$TAILNET

# 3) 必要に応じて再実行（既存 blog_dev を作り直す）
mysql -h tidb.$TAILNET -P 4000 -u root -e "DROP DATABASE IF EXISTS blog_dev"
bash dsl-tidb/load.sh -d blog_dev -t ./backup -H tidb.$TAILNET
```

### 本番環境への適用（prd）

前提:

- 取り元 DSQL endpoint の SSM パラメータが `/prd/shuntaka/dsql/cluster-endpoint`、AWS 認証は prd への ssm:GetParameter / dsql:DbConnectAdmin 権限を持つプロファイル (`aws-vault exec <profile>`)
- prd 用 SSM Parameter (`/prd/shuntaka/tailscale/*`) と gh variable (`TS_*_KEY_NAME --env prd`) は `docs/source/01_development.md` の手順で投入済み (dev/prd 共通の Tailscale OAuth client を `for STAGE_NAME in dev prd` の形で両方の path に入れる)
- 取り込み先 TiDB のデータベース名は `blog_prd` (stage 名の long と一致、`blog_prod` ではない)
- blog-api Lambda の `DATABASE_URL` は CDK の `blog-api-construct.ts` で `mysql://root@127.0.0.1:13306/blog_dev` がハードコードされている。prd デプロイ前に `blog_${stageName.long}` で stage 別に分岐するよう修正する (差分はタスク4 の実装記録に追記)
- 旧 prd DSQL への書き込みを止めるため、GitHub App の Webhook を一時的に Active off にしてから export を行う (export 中に記事が書き込まれると TiDB との差分が発生する)

```bash
# 0) Tailnet を環境変数化（生のホスト名は手順に書かない）
export TAILNET=$(tailscale status --json | jq -r '.MagicDNSSuffix')
echo "TAILNET=$TAILNET"

# 1) prd DSQL -> TSV（AWS prd 認証が通ったサブシェルで実行）
cd tools/dsql-cli

DSQL_ENDPOINT=$(
  aws ssm get-parameter \
    --name /prd/shuntaka/dsql/cluster-endpoint \
    --query Parameter.Value --output text
)
echo "DSQL_ENDPOINT=$DSQL_ENDPOINT"

bun run export --endpoint "$DSQL_ENDPOINT" --out-dir ./backup-prd

# 行数を控えておく（この後 TiDB 側と突合する）
ls -la backup-prd/
wc -l backup-prd/*.tsv

# 2) TiDB blog_prd に投入（DDL→LOAD DATA→SHOW WARNINGS→SELECT COUNT(*)）
bash dsl-tidb/load.sh \
  --database blog_prd \
  --tsv-dir ./backup-prd \
  --host tidb.$TAILNET

# 3) 取り込み確認: warning 0 + 行数が DSQL と一致
mysql -h tidb.$TAILNET -P 4000 -u root -N -B -e "
  SELECT 'users'         AS t, COUNT(*) FROM blog_prd.users UNION ALL
  SELECT 'tags',              COUNT(*) FROM blog_prd.tags UNION ALL
  SELECT 'articles',          COUNT(*) FROM blog_prd.articles UNION ALL
  SELECT 'articles_tags',     COUNT(*) FROM blog_prd.articles_tags"

# 4) blog-api prd を TiDB 向きにデプロイ（CDK 経由）
#    DATABASE_URL の database 部分が blog_prd になる修正を含むコミットを preview に
#    マージしてから deploy.yaml を起動する。
gh workflow run deploy.yaml --ref preview -f stageName=prd

# 5) 本番 API 疎通（cold start を込みで長めに見る）
curl -sS -o /dev/null -w "HTTP %{http_code} time=%{time_total}s\n" \
  --max-time 60 https://api.shuntaka.dev/health
curl -sS -o /dev/null -w "HTTP %{http_code} time=%{time_total}s\n" \
  --max-time 60 'https://api.shuntaka.dev/users/shuntaka/articles?type=tech'

# 6) GitHub App の Webhook を Active on に戻す
```

`backup-prd/` は記事本文を含むため git にコミットしない (`tools/dsql-cli/.gitignore` の `backup/` を `backup*/` のように広げるか、`backup-prd/` を個別に追加)。

旧 prd DSQL クラスタは rollback 余地のため当面残し、撤去はタスク4「iac/aws の DSQL 撤去」で実施する。

`SHOW WARNINGS` の出力が `Empty set` であれば取り込みは無警告で完了。warning が出た場合の典型例:

- `Warning 1105: the switch of check constraint is off` → CHECK 制約を DDL から外す（本ツールでは適用済み）
- `Warning 1265: Data truncated for column ...` → DDL の VARCHAR 長さ不足。`schema/*.sql` を見直す
- `Warning 1366: Incorrect string value ...` → TSV の文字コードまたは `CHARACTER SET utf8mb4` 指定の確認

## タスク3: blog-api の sqlx 切替（Postgres → MySQL）

### 設計

- `sqlx::PgPool` → `sqlx::MySqlPool`、Cargo.toml の features を `postgres` → `mysql`
- バインドパラメータ `$1, $2, ...` → `?`
- `uuid::Uuid` を `CHAR(36)` にマップ、`chrono::DateTime<Utc>` を `DATETIME(6)` にマップ

### チェックリスト

- [ ] `apps/blog-api` 配下の `Cargo.toml` の sqlx features を `postgres` → `mysql` に変更
- [ ] `apps/blog-api/adapter/src/repository/articles.rs` を MySQL 構文に書き換え
- [ ] `apps/blog-api/adapter/src/repository/users_articles.rs` を書き換え
- [ ] `apps/blog-api/adapter/src/repository/users.rs` を書き換え
- [ ] `cargo test -p adapter` のリポジトリ層テストが全て成功
- [ ] `apps/web` のローカル起動で記事一覧 / 記事詳細が表示

### 実装記録

（実装後に追記）

## タスク4: iac/aws の DSQL 撤去と TiDB 接続情報整備

### 設計

- DSQL クラスタ / 関連 IAM / `DSQL_CLUSTER_ENDPOINT` を削除
- TiDB 接続情報を Secrets Manager または SSM Parameter Store に格納
- Lambda/ECS の環境変数を `DATABASE_URL`（`mysql://` 形式）に切替

### チェックリスト

- [ ] CDK スタックから DSQL クラスタ定義を削除
- [ ] DSQL 関連 IAM ロール／ポリシーを削除
- [ ] `DSQL_CLUSTER_ENDPOINT` の Stack Output を削除
- [ ] TiDB 接続情報を格納する Construct を追加
- [ ] `DATABASE_URL`（`mysql://` 形式）に切替
- [ ] `docs/source/01_development.md` の「psql接続（DSQL）」「dsql-cli」節を TiDB 版に書き換え
- [ ] `bunx dotenv -- cdk synth -c stageName=dev` がエラーなく通る

### 実装記録

（実装後に追記）

## タスク5: blog-api Lambda の Tailscale サイドカー化

TiDB は自宅 LAN (`192.168.4.0/22`) に置き、Tailscale 経由でアクセスする。`blog-api` Lambda は既に `lambda.DockerImageFunction` (container image) なので、公式ガイド ([Tailscale on AWS Lambda](https://tailscale.com/docs/install/cloud/aws/aws-lambda)) に沿って **container image にサイドカーとして `tailscaled` (または tsnet forwarder バイナリ) を同梱** する。

### 既存 ACL の確認

現状の tailnet policy file (HuJSON):

```hujson
{
  "tagOwners": {
    "tag:aws-app": ["autogroup:admin"],
    "tag:k8s":     ["autogroup:admin"]
  },
  "acls": [
    { "action": "accept", "src": ["autogroup:member"], "dst": ["192.168.4.0/22:*"] },
    { "action": "accept", "src": ["tag:aws-app"],      "dst": ["192.168.4.0/22:4000"] },
    { "action": "accept", "src": ["autogroup:member"], "dst": ["tag:k8s:*"] }
  ]
}
```

`tag:aws-app → 192.168.4.0/22:4000` が既に許可されているため、Lambda の tailscaled が `tag:aws-app` で join すれば TiDB (4000/tcp) に届く。**ACL の変更は不要**。

### Tailscale OAuth client の作成方法

Lambda は cold start 毎に新規ノードとして Tailnet に join する。長寿命の auth key を環境変数に焼き込むのは credential leak と tag 変更時の影響範囲が大きいため、**OAuth client から都度 ephemeral auth key を発行** する形を取る。

#### Web UI での作成手順

1. Tailscale admin console → [Settings → OAuth clients](https://login.tailscale.com/admin/settings/oauth) を開く
2. **Generate OAuth client** をクリック
3. 以下を入力:

   | 項目            | 値                               | 補足                                                                                                                  |
   | --------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
   | **Description** | `blog-api-lambda`                | 用途を識別できる名前                                                                                                  |
   | **Scopes**      | `auth_keys` (write) のみチェック | `devices` 系は不要 (ephemeral ノードは disconnect で自動削除されるため)                                               |
   | **Tags**        | `tag:aws-app` を選択             | **必須**。未指定だと API 経由の auth key 発行が 400 で落ちる。この client は `tag:aws-app` 付きのキーしか発行できない |

4. **Generate client** を押すと `client_id` と `client_secret` が表示される (secret はこの画面でしか出ない、必ずコピー)
5. **`client_id` / `client_secret` の組** を AWS Secrets Manager に格納する (下記)

#### 用途別に分ける運用

OAuth client は **`tag:aws-app` 用 / 他バッチ用** といった具合に **tag 単位で分ける** のがベストプラクティス。`client_id` を取り違えても発行可能な tag が違うため、blast radius を tag 一つ分に絞れる。`tag:k8s` 用が必要になったら別途 `k8s-cluster` 等の名前で新規 client を切る。

### Secrets Manager への配置

CDK の SSM パス規約 (`/<stage>/<project>/...`) に合わせて、Secrets Manager に下記の構造で格納する想定:

```jsonc
// Secret name: /dev/shuntaka/tailscale/oauth-client
{
  "client_id": "<paste-from-tailscale-admin>",
  "client_secret": "<paste-from-tailscale-admin>",
}
```

Lambda は起動時 (INIT phase) に下記の順で動く:

1. Secrets Manager から `client_id` / `client_secret` を取得 (1 回のみ、warm 中は再利用)
2. `POST https://api.tailscale.com/api/v2/oauth/token` (`client_credentials` grant) で OAuth access token を取得 (1h 有効)
3. `POST https://api.tailscale.com/api/v2/tailnet/-/keys` で auth key を発行
   ```json
   {
     "capabilities": {
       "devices": {
         "create": {
           "reusable": false,
           "ephemeral": true,
           "preauthorized": true,
           "tags": ["tag:aws-app"]
         }
       }
     },
     "expirySeconds": 600
   }
   ```
4. 得られた `tskey-auth-...` を `tailscale up --auth-key=... --hostname=blog-api-lambda` に渡す

### 認証パラメータの推奨値

| パラメータ      | 値                | 理由                                                                          |
| --------------- | ----------------- | ----------------------------------------------------------------------------- |
| `reusable`      | `false`           | 一度限り。cold start ごとに発行                                               |
| `ephemeral`     | `true`            | **Lambda には必須**。disconnect で admin console から自動削除される           |
| `preauthorized` | `true`            | device approval 待ちにしない                                                  |
| `expirySeconds` | `600` (10 分)     | 発行してすぐ `tailscale up` に渡すので短くて良い。長いと未使用 key が散らかる |
| `tags`          | `["tag:aws-app"]` | OAuth client に紐付けた tag と一致させる                                      |

### Lambda 上の tsnet / tailscaled 運用

- `state dir = /tmp/tailscale` を必ず使う (Lambda の `/tmp` のみ rw)
- INIT phase で `tailscaled --tun=userspace-networking --socks5-server=localhost:1055` を起動 (`/dev/net/tun` が無いため userspace networking 必須)
- 接続先は **MagicDNS 名 `tidb.<TAILNET>:4000`** で OK (private IP 直指定は不要)。tailscaled / tsnet が Tailnet の DNS を解決する
- Lambda が VPC 内かつ NAT GW なしだと `login.tailscale.com:443` に出られず join 失敗するため、**VPC 配置時は NAT GW 必須** (or public Lambda)
- cold start レイテンシ +1.5〜4s (OAuth token 取得 + auth key 発行 + tsnet up + DERP 確立) を見込む

### Rust 連携の方式

`sqlx` は `ALL_PROXY` を尊重しないため、公式サンプルの `ALL_PROXY=socks5://localhost:1055/` ではそのまま動かない。下記いずれかを取る:

| 案                                                  | 内容                                                                                                                                                                               | 評価                                            |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **A1. tsnet forwarder バイナリを Go で同梱** (推奨) | `tsnet.Server.Dial(ctx, "tcp", "tidb.${TAILNET}:4000")` で `127.0.0.1:13306 → tidb.${TAILNET}:4000` を中継。Rust は `mysql://...@127.0.0.1:13306/blog_dev` で繋ぐ。`sqlx` 触らない | Go バイナリ 30 行、SOCKS5 不要、Rust ノータッチ |
| A2. `mysql_async` に乗り換え                        | `mysql_async::Opts::socks_proxy` で SOCKS5 直サポート                                                                                                                              | sqlx 全置換コスト                               |
| A3. sqlx + `tokio-socks`                            | TCP stream を SOCKS5 で wrap して sqlx に渡す                                                                                                                                      | sqlx 0.9 の公式 API に無くハック必要            |

A1 を採用する場合、`adapter/src/database/mod.rs` の `ensure_tailnet_ready()` は永続的に no-op のまま (Rust は `127.0.0.1:13306` を見るだけ)。

### チェックリスト

- [ ] Tailscale admin で OAuth client `blog-api-lambda` を作成 (Scopes: `auth_keys` write、Tags: `tag:aws-app`)
- [ ] `client_id` / `client_secret` を Secrets Manager `/dev/shuntaka/tailscale/oauth-client` に JSON で格納
- [ ] `apps/blog-api/Dockerfile` を multi-stage 化し、tsnet forwarder バイナリ (or `tailscaled`) を同梱
- [ ] entrypoint で Secrets Manager → OAuth token → auth key → `tailscale up` / `tsnet up` のチェーンを実装
- [ ] CDK で Lambda の env に `FORWARD_TARGET=tidb.${TAILNET}:4000` と `TS_OAUTH_SECRET_NAME=/dev/shuntaka/tailscale/oauth-client` を注入
- [ ] Lambda IAM role に `secretsmanager:GetSecretValue` を付与
- [ ] 初回 invoke で `tailscale status` 相当のログを出し、ノードが `tag:aws-app` で join されていることを確認
- [ ] blog-api 経由で `tidb.${TAILNET}:4000` に接続でき、記事一覧 API が 200 を返すことを確認

### 地雷 (Tailscale 経験者からの受け売り)

- **OAuth client に tag を紐付け忘れる** → auth key 発行が全部 400
- **`tagOwners` 書き忘れ** → tag 付きノードが ACL から見えず silent に接続不能 (現状 `tag:aws-app` は `autogroup:admin` で書かれているので OK)
- **`ephemeral: false` で Lambda 回す** → admin console が死んだノードで埋まる、device 上限に当たる
- **auth key を環境変数に直書き** → ローテ不能、tag 変更時に全 Lambda 再 deploy。OAuth で都度発行に倒す
- **state を Lambda パッケージ内に置こうとする** → read-only で起動失敗、必ず `/tmp`
- **Lambda が VPC かつ NAT GW なし** → `login.tailscale.com:443` に出られず join 失敗
- **direct connection 前提で性能設計** → Lambda は短命で NAT traversal が安定する前に終わることが多い。DERP relay 前提でレイテンシ見積もる

### 実装記録

（実装後に追記）

## 残課題 / フォローアップ

（移行完了後に追記）
