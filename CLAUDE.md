# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Git Rules

- PR のベースブランチは常に `preview`。`main` 向けの PR は作成しない
- `main` へのマージは人間が行う

## Security (Secret Leak Defense)

Claude Code 経由でのシークレット漏洩を4層で防ぐ。

| 層  | 何を守るか                                | しくみ                                                                                                                                                                                                                       |
| --- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | サブプロセスへの環境変数経由の漏洩        | `.claude/settings.json` で `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` を設定。Anthropic / AWS secret・session・Bedrock / Azure client secret / Google ADC / Anthropic Foundry の7変数を Bash・Hook・MCP stdio サブプロセスから除去 |
| 2   | プロンプト本文に書かれたシークレット      | `.claude/hooks/secretlint-prompt.ts` (UserPromptSubmit, Bun shell) で secretlint を実行。検出時は exit 2 でプロンプト送信をブロックして再入力を促す                                                                          |
| 3   | Git staged に混入したシークレット         | `lefthook.yaml` の `pre-commit` で secretlint と gitleaks を両方実行。Claude 経由でない手動コミットもカバー                                                                                                                  |
| 4   | pre-commit hook の `--no-verify` バイパス | `.claude/hooks/block-noverify.ts` (PreToolUse Bash, `git commit *` / `git push *` にスコープ) で `--no-verify` / `-n` を含むコマンドを exit 2 で拒否                                                                         |

secretlint と gitleaks は検出範囲が異なる（Slack Webhook / Anthropic API Key は secretlint、Stripe / PEM は gitleaks）ため、pre-commit に併置している。Claude が `git commit` を実行した時点で検出されれば、stderr のフィードバックで自己修正できる。

### 前提ツール

- `gitleaks` バイナリを `brew install gitleaks` で導入する。未インストールだと pre-commit が失敗する
- `jq` (macOS 標準では未導入のため `brew install jq` が必要な場合あり)
- secretlint は `bun install` で自動的に揃う

### 誤検知の調整

`.secretlintrc.json` の `@secretlint/secretlint-rule-database-connection-string` で localhost / 127.0.0.1 / `db` ホスト名向けのローカル接続文字列を `allows` 正規表現で許可している。新たに誤検知が出たらここに追加。

### スコープ外

- env scrub は `OPENAI_API_KEY` / `CLOUDFLARE_API_TOKEN` / `AWS_ACCESS_KEY_ID` を伝播させる
- secretlint デフォルトは AWS Access Key ID の単独 ID 検出が OFF
- gitleaks デフォルトルールには Anthropic API Key が未収録（secretlint 側でカバー）
- `LEFTHOOK=0 git commit` 等の環境変数経由バイパスや `git -c core.hooksPath=/dev/null` 等の config 上書きは block-noverify hook では検出しない

## Project Overview

フルスタックのモノレポプロジェクト。ブログシステム（Web + API）とインフラ、ドキュメントを含む。

## Architecture

```
apps/
├── web/          # Next.js 16 フロントエンド (React 19, Tailwind CSS 4)
└── blog-api/     # Rust/Axum バックエンドAPI (SQLx, PostgreSQL/DSQL)

tools/
├── dsql-cli/     # TypeScript マイグレーションCLI (AWS DSQL対応)
└── tidb-seeder/  # TiDB 用ダミーデータ TSV ジェネレータ (load.sh と組み合わせて使う)

iac/
└── aws/          # AWS CDK インフラ (TypeScript)

docs/             # Sphinx ドキュメント (Python/uv)
```

## Documentation

環境構築、デプロイ手順、ツールの詳細な使い方は `docs/source/01_development.md` を参照。

apps/web の作業時は `apps/web/CLAUDE.md` を参照（workspace 専用ガイド + ブランド仕様 `apps/web/DESIGN.md`）。

## Commands

```bash
# 開発
bun run dev

# ビルド・テスト
bun run build
bun run test

# コード品質チェック（リント + スペル + 型）
bun run check

# 個別実行
bun run lint         # Vite+ (oxlint, oxfmt) + Prettier
bun run fix          # 自動修正
bun run spell-check  # cspell
bun run type-check   # TypeScript

# デプロイ
bun run deploy       # AWS CDK
```

### AWS CDK（iac/awsディレクトリで実行）

```bash
cd iac/aws
bunx dotenv -- cdk synth -c stageName=dev
```

### dsql-cli (マイグレーション)

```bash
cd tools/dsql-cli

# ローカルPostgreSQL
bun run migrate --endpoint postgresql://postgres:postgres@localhost:5433/postgres
bun run drop --endpoint postgresql://postgres:postgres@localhost:5433/postgres

# AWS DSQL
bun run migrate --endpoint $DSQL_CLUSTER_ENDPOINT
bun run drop --endpoint $DSQL_CLUSTER_ENDPOINT
```

### ローカルDB起動

```bash
# ルートディレクトリで
docker compose up -d postgres
```

## Tech Stack

- **パッケージ管理**: Bun + Turbo
- **フロントエンド**: Next.js 16, React 19, TypeScript 5
- **バックエンド**: Rust (Axum, SQLx), AWS DSQL
- **インフラ**: AWS CDK, Docker
- **コード品質**: Vite+ (oxlint, oxfmt), Prettier (YAML), cspell

## DSQL Constraints

AWS DSQLは以下をサポートしない：

- `CREATE DATABASE` (postgres固定)
- `CREATE FUNCTION` (plpgsql)
- `CREATE TRIGGER`
- `FOREIGN KEY` 制約
- `ALTER TABLE ADD CONSTRAINT` （制限あり）

仮想リレーションは `.tbls.yaml` の `relations` で定義。

### スキーマ変更の方針

DSQLではALTER TABLEに制限があるため、スキーマ変更は以下の手順で行う：

1. `tools/dsql-cli/dsl/` 配下の元SQLファイルを直接修正
2. `bun run drop` でスキーマ削除
3. `bun run migrate` で再作成

```bash
cd tools/dsql-cli
bun run drop --endpoint postgresql://postgres:postgres@localhost:5433/postgres
bun run migrate --endpoint postgresql://postgres:postgres@localhost:5433/postgres
```

## Legacy Code Reference

新機能実装時にレガシーコードを参照する場合の探し方：

### レガシーバックエンド（Lambda/TypeScript）

```
.legacy/hozi-dev-backend/src/lambda/
├── handlers/apig-trigger/     # API Gatewayハンドラー
│   ├── apig-get-article-list-handler.ts      # 認証済みユーザーの記事一覧
│   └── apig-get-user-article-list-handler.ts # 公開記事一覧（type指定）
├── domains/
│   ├── use-cases/             # ユースケース層
│   ├── service/               # サービス層（ビジネスロジック）
│   └── type/                  # 型定義
└── infrastructures/           # 外部サービス連携（DynamoDB, Cloudinary, SSM）
```

### レガシーフロントエンド（Next.js Pages Router）

```
.legacy/hozi-dev-frontend/
├── pages/                     # Pages Router
├── src/
│   ├── hooks/                 # カスタムフック（API呼び出し）
│   ├── fetch/                 # API fetch関数
│   └── interface/             # 型定義
└── components/                # UIコンポーネント
```

### レガシー仕様書

```
.legacy/specification/
├── hozi-dev-api.yaml          # OpenAPI仕様（エンドポイント定義）
└── hozi-dev.adoc              # AsciiDoc仕様書
```

### DBスキーマドキュメント

```
docs/source/db/
├── app.articles.md            # 記事テーブル
├── app.articles_tags.md       # 記事-タグ関連
├── app.users.md               # ユーザーテーブル
├── app.roles.md               # ロールテーブル
├── app.tags.md                # タグテーブル
└── schema.json                # スキーマJSON
```

### 移植時のマッピング

| レガシー（DynamoDB）               | 新規（DSQL）              |
| ---------------------------------- | ------------------------- |
| `typePublishAt` ("type-timestamp") | `status` + `published_at` |
| `type` (tech/note/life)            | `type` カラム             |
| `category[]`                       | 廃止（tagsで代替）        |
| `articleId`                        | `slug`                    |
| `userId`                           | `user_id` (UUID)          |

## Markdown変換

MarkdownからHTMLへの変換はAPI側（Rust）で実行する。

### 構成

- **crate**: `apps/blog-api/markdown`
- **ライブラリ**: comrak + syntect（シンタックスハイライト）
- **レスポンス**: `content`（生Markdown）と`content_html`（変換済みHTML）を両方返す

### レガシー仕様

レガシーのMarkdown変換仕様は以下を参照：

```
.legacy/shuntaka-dev-packages/packages/markdown-to-html/
├── src/index.ts           # markdown-it + prismjs
└── src/mdOption/          # カスタムコンテナ（details, message）
```

主な機能：

- シンタックスハイライト（Prism.js相当 → Rust: syntect）
- カスタムコンテナ（`:::details`, `:::message`）
- 埋め込み（SpeakerDeck, CodePen）
- 画像サイズ指定、遅延ロード
- PlantUML
- アンカーリンク
