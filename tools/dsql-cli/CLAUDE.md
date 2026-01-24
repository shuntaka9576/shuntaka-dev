# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AWS DSQL/PostgreSQL用のマイグレーションCLIツール。ローカルPostgreSQLとAWS DSQLの両方に対応。

## Commands

```bash
# マイグレーション実行
bun run migrate --endpoint postgresql://postgres:postgres@localhost:5433/postgres  # ローカル
bun run migrate --endpoint $DSQL_CLUSTER_ENDPOINT                                    # DSQL

# スキーマ削除
bun run drop --endpoint postgresql://postgres:postgres@localhost:5433/postgres

# DynamoDB JSONL → SQL変換
bun run convert --input <jsonl-path> --output <sql-path>
```

## Architecture

- `src/index.ts` - CLIエントリポイント（migrate/drop/convertコマンド）
- `src/convert.ts` - DynamoDB→DSQL変換ロジック
- `src/types.ts` - 型定義（DynamoDB/DSQL両スキーマ）
- `dsl/` - SQLマイグレーションファイル（番号順に実行）
  - 01-06: スキーマ定義
  - 99: シードデータ（convert生成）

## DSQL Constraints

AWS DSQLは以下をサポートしない：
- `CREATE DATABASE`
- `CREATE FUNCTION` (plpgsql)
- `CREATE TRIGGER`
- `FOREIGN KEY` 制約

## Documentation

詳細な使い方は `docs/source/01_development.md` の「dsql-cli」セクションを参照。コマンド変更時は同期すること。
