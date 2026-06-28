# dsl-tidb: DSQL → TSV → TiDB 取り込み手順書

`tools/dsql-cli/dsl-tidb/` 配下の DDL と `load.sh` で、AWS DSQL からエクスポートした TSV を TiDB（self-hosted）に取り込む。スキーマ名を `--database` で差し替えるだけで `blog_dev` / `blog_prod` 等で同じ DSL を再利用できる。

## ディレクトリ構成

```
dsl-tidb/
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
├── load.sh        # ラッパースクリプト（sed で ${SCHEMA}/${TSV} を置換）
└── README.md
```

`load.sh` は `schema/*.sql` を流したあと `load/*.sql` をテーブルごとに流す。各 `load/*.sql` は同一セッション内で `SET time_zone='+00:00'` → `LOAD DATA LOCAL INFILE` → `SHOW WARNINGS` を投げるので、mysql クライアントが warning を画面に表示する。

## 前提

| 項目         | 必要なもの                                                                        |
| ------------ | --------------------------------------------------------------------------------- |
| 取り込み先   | TiDB（v8.x、`SELECT @@local_infile = 1`）                                         |
| 接続経路     | Tailnet 上の `tidb.<TAILNET>`（Tailscale ログイン済み）                           |
| クライアント | `mysql`（MySQL 8.x クライアント、`--local-infile=1` 対応）                        |
| TSV 生成     | `bun run export`（`tools/dsql-cli` 配下、`@aws-sdk/dsql-signer` 経由で IAM 認証） |
| AWS 認証     | DSQL クラスタが読める IAM 認証（例: `aws-vault exec <profile>` のサブシェル）     |

`TAILNET` は固有の Tailnet 名を直書きせず、毎回コマンドで取得する。

```bash
export TAILNET=$(tailscale status --json | jq -r '.MagicDNSSuffix')
echo "TAILNET=$TAILNET"
```

## 1. DSQL → TSV エクスポート

AWS 認証が通った shell（`aws-vault exec <profile>` 等）で実行する。SSM Parameter Store から dev クラスタの endpoint を取り出し、`bun run export` に渡す。

```bash
cd tools/dsql-cli

DSQL_ENDPOINT=$(
  aws ssm get-parameter \
    --name /dev/shuntaka/dsql/cluster-endpoint \
    --query Parameter.Value --output text
)
echo "DSQL_ENDPOINT=$DSQL_ENDPOINT"

bun run export --endpoint "$DSQL_ENDPOINT" --out-dir ./backup
```

`bun run export` が行うこと:

- `information_schema` からカラム順と主キーを取得
- セッション TZ を UTC に固定（`SET TIME ZONE 'UTC'`）
- `timestamp(tz)` は `to_char(... AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')`、それ以外は `(col)::text` で文字列化
- 主キー順にキーセットページング（`WHERE pk > $1::<type>` / 複合キーは行値比較）
- PG TEXT 互換 TSV (NULL=`\N`、`\\` / `\t` / `\n` / `\r` をエスケープ) を `<out-dir>/<schema>.<table>.tsv` に書き出す

出力例:

```text
Connecting to DSQL: <cluster-id>.dsql.<region>.on.aws
Connected successfully
Exporting 4 tables from schema "app" -> ./backup/
  app.users: 1 rows -> backup/app.users.tsv
  app.tags: 0 rows -> backup/app.tags.tsv
  app.articles: 118 rows -> backup/app.articles.tsv
  app.articles_tags: 0 rows -> backup/app.articles_tags.tsv
Export completed successfully
```

本番 DSQL を export する場合は `--name /prd/shuntaka/dsql/cluster-endpoint` に変える（CDK の SSM パス規約は `/<stage>/<project>/dsql/cluster-endpoint`）。

## 2. TSV → TiDB ロード

`load.sh` で DDL → LOAD DATA → 行数確認 を一括実行する。`--database` で取り込み先スキーマを切り替える（`blog_dev` / `blog_prod` 等）。

```bash
cd tools/dsql-cli

export TAILNET=$(tailscale status --json | jq -r '.MagicDNSSuffix')

# 再投入する場合は事前に DROP（任意）
mysql -h tidb.$TAILNET -P 4000 -u root \
  -e "DROP DATABASE IF EXISTS blog_dev"

bash dsl-tidb/load.sh \
  --database blog_dev \
  --tsv-dir ./backup \
  --host tidb.$TAILNET
```

出力例:

```text
==> Applying DDL to `blog_dev` on tidb.<TAILNET>:4000
  apply 01_schema.sql
  apply 02_users.sql
  apply 03_tags.sql
  apply 04_articles.sql
  apply 05_articles_tags.sql

==> LOAD DATA (TSV dir: .../backup, source schema: app)
  load users <- .../backup/app.users.tsv
table_name      warnings
users           0
  load tags <- .../backup/app.tags.tsv
table_name      warnings
tags            0
  load articles <- .../backup/app.articles.tsv
table_name      warnings
articles        0
  load articles_tags <- .../backup/app.articles_tags.tsv
table_name      warnings
articles_tags   0

==> Row count verification
  blog_dev.users                 1
  blog_dev.tags                  0
  blog_dev.articles              118
  blog_dev.articles_tags         0

Done.
```

各 `load/*.sql` の末尾は `SELECT '<table>' AS table_name, @@warning_count AS warnings;` → `SHOW WARNINGS;` の順で投げる。これは:

- `@@warning_count` で **テーブル毎に warning 件数を明示表示**する（0 でも `0` と出る。mysql の batch モードは空集合を非表示にするので、SHOW WARNINGS だけだと warning 0 が画面に出ない）
- 続けて `SHOW WARNINGS` で 1 件でも warning があれば内訳を表示する

warning が出た場合は count 行の直後に内訳が並ぶ:

```text
table_name      warnings
articles        2
Level   Code    Message
Warning 1265    Data truncated for column 'title' at row 17
Warning 1265    Data truncated for column 'description' at row 42
```

**手順書としての完了条件は、各テーブルの `warnings` 列が `0` + 行数が DSQL の `SELECT COUNT(*)` と一致**。

### load.sh のオプション

```text
Required:
  -d, --database <name>      取り込み先 TiDB データベース名 (例: blog_dev / blog_prod)

Connection:
  -H, --host <host>          TiDB ホスト (default: $TIDB_HOST or 127.0.0.1)
  -P, --port <port>          TiDB ポート (default: $TIDB_PORT or 4000)
  -u, --user <user>          TiDB ユーザ (default: $TIDB_USER or root)
  -p, --password <password>  TiDB パスワード (default: $TIDB_PASSWORD or 空)
                             ※ MYSQL_PWD 経由で渡すので ps に漏れない

Data:
  -t, --tsv-dir <dir>        TSV 入力ディレクトリ (default: $TSV_DIR or ./backup)
  -s, --source-schema <name> TSV ファイル名のスキーマ接頭辞 (default: app)
                             解決パス: <tsv-dir>/<source-schema>.<table>.tsv
```

## LOAD DATA 文の構造

`load/02_users.sql` を例に取ると、`${SCHEMA}` / `${TSV}` を `load.sh` が sed で置換する:

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

ポイント:

- `LOAD DATA LOCAL INFILE` … クライアント側ファイルをサーバに送る方式。`mysql --local-infile=1` でクライアントを起動し、TiDB 側の `local_infile=1` も必要。
- `CHARACTER SET utf8mb4` … TSV を utf8mb4 として解釈。
- `FIELDS TERMINATED BY '\t' ESCAPED BY '\\'` … PG TEXT エスケープ規則 (`\N`, `\t`, `\n`, `\r`, `\\`) と相互運用。
- 直接カラム名で受けたフィールド (`user_id`/`name`/`email`) は `\N` が自動で NULL になる。
- `@var` で受けたフィールド (NULL 可カラム / 型変換が必要なカラム) は `\N` が文字列のまま入るので、SET 句で `NULLIF(@var, '\N')` を明示する。
- 行末に `SHOW WARNINGS;` を置くことで、`LOAD DATA` と同じセッションで警告を出力する（別接続では取れない）。

## 行数整合チェック

DSQL 側で取った件数と TiDB 側の件数を突き合わせる。

```bash
# DSQL 側（aws-vault exec のサブシェルで）
DSQL_ENDPOINT=$(aws ssm get-parameter \
  --name /dev/shuntaka/dsql/cluster-endpoint \
  --query Parameter.Value --output text)

bun -e "
import { DsqlSigner } from '@aws-sdk/dsql-signer';
import pg from 'pg';
const s = new DsqlSigner({ hostname: process.env.E });
const t = await s.getDbConnectAdminAuthToken();
const c = new pg.Client({ host: process.env.E, port: 5432, database: 'postgres', user: 'admin', password: t, ssl: true });
await c.connect();
for (const tbl of ['users','tags','articles','articles_tags']) {
  const r = await c.query(\`SELECT count(*) FROM app.\${tbl}\`);
  console.log(\`\${tbl}: \${r.rows[0].count}\`);
}
await c.end();
" E=$DSQL_ENDPOINT
```

```bash
# TiDB 側
export TAILNET=$(tailscale status --json | jq -r '.MagicDNSSuffix')
for t in users tags articles articles_tags; do
  printf "%-15s " "$t"
  mysql -h tidb.$TAILNET -P 4000 -u root -N -B \
    -e "SELECT COUNT(*) FROM blog_dev.\`$t\`"
done
```

両者が一致していれば取り込み成功。

## トラブルシュート

| 症状                                                           | 原因と対処                                                                                                                                                                                                                            |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Warning 1105: the switch of check constraint is off`          | TiDB の `tidb_enable_check_constraint` が既定 OFF。`schema/04_articles.sql` の CHECK は外してある。クラスタ単位で有効化したい場合は `SET GLOBAL tidb_enable_check_constraint = ON;` のうえで ALTER TABLE で再追加する。               |
| `Warning 1265: Data truncated for column 'xxx' at row N`       | `schema/*.sql` の VARCHAR 長さ不足。元 DSQL 側のカラム長分布を確認し DDL を広げる。                                                                                                                                                   |
| `Warning 1366: Incorrect string value ...`                     | 文字コード不一致。`CHARACTER SET utf8mb4` が `load/*.sql` に明示されているか、TSV が UTF-8 で出力されているか確認。                                                                                                                   |
| `ERROR 3948: Loading local data is disabled`                   | サーバ側 `local_infile` が OFF。`SET GLOBAL local_infile = 1;` で有効化（要 SUPER 権限）。                                                                                                                                            |
| `ERROR 2068: LOAD DATA LOCAL INFILE file request rejected ...` | mysql クライアント側で `--local-infile=1` を忘れている（`load.sh` は付与済み）。                                                                                                                                                      |
| `Cannot find module './cjs/index.cjs' from ''`                 | `bun run export` で出る場合、ローカルの `node` が mise などで unmet。`export` スクリプトは `bun src/index.ts ...` 形式で実行するため、node 不要で動く。tsx を介する `migrate` / `drop` / `convert` は別途 node を解決する必要がある。 |

## 本番への適用

開発と本番で違うのは `--database` と export 元 DSQL endpoint だけ。

```bash
# 本番 DSQL から export
DSQL_ENDPOINT=$(aws ssm get-parameter \
  --name /prd/shuntaka/dsql/cluster-endpoint \
  --query Parameter.Value --output text)
bun run export --endpoint "$DSQL_ENDPOINT" --out-dir ./backup-prd

# 本番 TiDB スキーマに投入
bash dsl-tidb/load.sh \
  --database blog_prod \
  --tsv-dir ./backup-prd \
  --host tidb.$TAILNET
```

DDL / LOAD DATA テンプレートは完全に共通。スキーマ切り替えのために DSL を分岐させる必要はない。
