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
+------------+   COPY ... TO STDOUT    +-----------+   LOAD DATA LOCAL INFILE   +------+
| AWS DSQL   | ----------------------> | TSV files | -------------------------> | TiDB |
+------------+   (dsql-cli export)     +-----------+   (dsl-tidb/load.sh)       +------+
```

- バックアップは `app.users` → `app.tags` → `app.articles` → `app.articles_tags` の順で取得・投入する
- 出力フォーマットは PostgreSQL 標準の `COPY ... TO STDOUT WITH (FORMAT text)`。NULL は `\N`、改行/タブ/バックスラッシュは PG 標準エスケープ
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
- 依存追加: `pg-copy-streams`
- CLI オプション: `-e/--endpoint`（環境変数 `DSQL_CLUSTER_ENDPOINT` をデフォルト）, `-o/--out-dir`（デフォルト `backup/`）

### チェックリスト

- [ ] DSQL での `COPY ... TO STDOUT` サポートを実機で確認（未対応なら `SELECT *` フォールバックに切替）
- [ ] `pg-copy-streams` を `tools/dsql-cli/package.json` に追加
- [ ] `export` サブコマンドを実装
- [ ] `package.json` の `scripts` に `"export": "tsx src/index.ts export"` を追加
- [ ] 4テーブル分の TSV が生成され、行数が `SELECT count(*)` と一致することを確認

### 実装記録

（実装後に追記）

## タスク2: TiDB 用 DDL 整備と LOAD DATA 投入手順

### 設計

- 新規ディレクトリ `tools/dsql-cli/dsl-tidb/`（既存 `dsl/` は改変しない）
- LOAD DATA は `LOAD DATA LOCAL INFILE` を採用（Self-hosted 前提）

### チェックリスト

- [ ] `dsl-tidb/01_schema.sql`（`CREATE DATABASE IF NOT EXISTS app;`）
- [ ] `dsl-tidb/02_users.sql`
- [ ] `dsl-tidb/03_tags.sql`
- [ ] `dsl-tidb/04_articles.sql`
- [ ] `dsl-tidb/05_articles_tags.sql`
- [ ] `dsl-tidb/load.sh` で 4 テーブル分の LOAD DATA を順次実行
- [ ] ローカル TiDB（Docker）で `SELECT count(*)` が DSQL と一致

### LOAD DATA クエリ例

```sql
LOAD DATA LOCAL INFILE 'backup/app.users.tsv'
INTO TABLE app.users
FIELDS TERMINATED BY '\t' ESCAPED BY '\\'
LINES TERMINATED BY '\n'
(user_id, name, email, @gh, created_at, updated_at)
SET github_installation_id = NULLIF(@gh, '\\N');
```

### 実装記録

（実装後に追記）

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

## 残課題 / フォローアップ

（移行完了後に追記）
