# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Language

日本語で回答してください。

## Project Overview

フルスタックのモノレポプロジェクト。ブログシステム（Web + API）とインフラ、ドキュメントを含む。

## Architecture

```
apps/
├── web/          # Next.js 16 フロントエンド (React 19, Tailwind CSS 4)
└── blog-api/     # Rust/Axum バックエンドAPI (SQLx, PostgreSQL/DSQL)

tools/
└── dsql-cli/     # TypeScript マイグレーションCLI (AWS DSQL対応)

iac/
└── aws/          # AWS CDK インフラ (TypeScript)

docs/             # Sphinx ドキュメント (Python/uv)
```

## Commands

```bash
# 開発
pnpm dev

# ビルド・テスト
pnpm build
pnpm test

# コード品質チェック（リント + スペル + 型）
pnpm check

# 個別実行
pnpm lint         # Biome + Prettier
pnpm fix          # 自動修正
pnpm spell-check  # cspell
pnpm type-check   # TypeScript

# デプロイ
pnpm deploy       # AWS CDK
```

### dsql-cli (マイグレーション)

```bash
cd tools/dsql-cli

# ローカルPostgreSQL
pnpm migrate --endpoint postgresql://postgres:postgres@localhost:5433/postgres
pnpm drop --endpoint postgresql://postgres:postgres@localhost:5433/postgres

# AWS DSQL
pnpm migrate --endpoint $DSQL_CLUSTER_ENDPOINT
pnpm drop --endpoint $DSQL_CLUSTER_ENDPOINT
```

### ローカルDB起動

```bash
# ルートディレクトリで
docker compose up -d postgres
```

## Tech Stack

- **パッケージ管理**: pnpm 10.x + Turbo
- **フロントエンド**: Next.js 16, React 19, TypeScript 5
- **バックエンド**: Rust (Axum, SQLx), AWS DSQL
- **インフラ**: AWS CDK, Docker
- **コード品質**: Biome, Prettier (YAML), cspell

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
2. `pnpm drop` でスキーマ削除
3. `pnpm migrate` で再作成

```bash
cd tools/dsql-cli
pnpm drop --endpoint postgresql://postgres:postgres@localhost:5433/postgres
pnpm migrate --endpoint postgresql://postgres:postgres@localhost:5433/postgres
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

| レガシー（DynamoDB） | 新規（DSQL） |
|---------------------|-------------|
| `typePublishAt` ("type-timestamp") | `status` + `published_at` |
| `type` (tech/note/life) | `type` カラム |
| `category[]` | 廃止（tagsで代替） |
| `articleId` | `slug` |
| `userId` | `user_id` (UUID) |

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
