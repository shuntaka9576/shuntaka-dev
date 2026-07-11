# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Git Rules

- PR のベースブランチは常に `main`
- 本番リリースは tagpr が作成するリリース PR（`tagpr` ラベル付き、CalVer タグ）のマージで行う。リリース PR のマージは人間が行う

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
├── blog-api/     # Rust/Axum バックエンドAPI (SQLx, TiDB [MySQL互換])
└── tidb-proxy/   # ECS Fargate 常駐プロキシ (Go tsnet で Tailnet 上の TiDB へ TCP 中継 + squid)

tools/
├── dsql-cli/     # 旧DSQL用CLI + DSQL→TiDB 移行ツール (dsl-tidb/)。旧DSQLは撤去待ち
└── tidb-seeder/  # TiDB 用ダミーデータ TSV ジェネレータ (load.sh と組み合わせて使う)

iac/
└── aws/          # AWS CDK インフラ (TypeScript)

cluster/          # 自作MiniPCクラスタ (k8s + TiDB + Tailscale) の manifests / scripts

docs/             # Sphinx ドキュメント (Python/uv)
```

## Documentation

環境構築、デプロイ手順、ツールの詳細な使い方は `docs/source/01_開発ドキュメント/01_development.md` を参照。

apps/web の作業時は `apps/web/CLAUDE.md` を参照（workspace 専用ガイド + ブランド仕様 `apps/web/DESIGN.md`）。

## Cluster Operations

`cluster/` 配下で自作MiniPCクラスタ (k8s + TiDB + Tailscale) の Kubernetes マニフェストと運用スクリプトを管理する。

### ルール: 必ず再現可能な手順を作ること

クラスタに対してコマンドを実行した場合は `docs/source/98_tasks/` 配下の手順書に同期する。トラブルシュートをした場合は、解決時に内省し必要最小限のコマンドを同期すること。

### 参照先

- ゼロからの構築手順: `docs/source/01_開発ドキュメント/02_cluster.md`
- 物理機材・ソフトウェア構成: `docs/source/01_開発ドキュメント/01_development.md` の「構成 > 必要機材」
- 全消し→再構築手順: `docs/source/98_tasks/2026-06-27-tidb-full-rebuild/index.md`
- 構築時の作業記録: `docs/source/98_tasks/`（2026-06-25〜2026-06-28 のクラスタ関連エントリ）
- 実体: `cluster/manifests/`, `cluster/scripts/`

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

### データベース接続 (TiDB)

blog-api の接続先は自作クラスタ上の TiDB。ローカル開発は Tailnet 経由で dev DB (`blog_dev`) に直接繋がる（`apps/blog-api/Makefile.toml` が既定の DATABASE_URL を組み立てる。Tailscale ログインが前提）。

```bash
export TAILNET=$(tailscale status --json | jq -r '.MagicDNSSuffix')
mysql -h tidb.${TAILNET} -P 4000 -u root -p
```

## Tech Stack

- **パッケージ管理**: Bun + Turbo
- **フロントエンド**: Next.js 16, React 19, TypeScript 5
- **バックエンド**: Rust (Axum, SQLx), TiDB (自作k8sクラスタ上。本番 Lambda は tidb-proxy 経由、ローカル開発は Tailnet 直結)
- **インフラ**: AWS CDK, Docker
- **コード品質**: Vite+ (oxlint, oxfmt), Prettier (YAML), cspell

## Database (TiDB)

本番/開発の DB は自作 k8s クラスタ上の TiDB（MySQL 互換）。dev/prd の分離は database (`blog_dev` / `blog_prd`) とユーザー権限で行う。

- ローカル開発: Tailnet 経由で `mysql://root@tidb.<tailnet>:4000/blog_dev` に直結（`apps/blog-api/Makefile.toml` の既定値。`DATABASE_URL` で上書き可）
- 本番 Lambda: VPC 内から tidb-proxy (ECS Fargate, `tidb-proxy.internal:13306`) 経由で接続
- スキーマ DDL: `tools/dsql-cli/dsl-tidb/schema/`（`${SCHEMA}` 注入で blog_dev / blog_prd を共用、適用は `dsl-tidb/load.sh`）
- 仮想リレーション（tbls の ER 図用）は `docs/.tbls.yaml` の `relations` で定義

### 旧 DSQL（撤去待ち）

旧構成の AWS DSQL クラスタは残置されているが、現行の blog-api からは参照されない（`iac/aws/lib/api/main-stack.ts` 参照）。旧 DSQL の運用コマンドは `docs/source/01_開発ドキュメント/01_development.md` の「旧DSQL（撤去待ち）」を参照。

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

tbls 生成（`docs/` で `bun run doc-gen`、生成元は TiDB `blog_dev`）。

```
docs/source/01_開発ドキュメント/05_db/
├── articles.md                # 記事テーブル
├── articles_tags.md           # 記事-タグ関連
├── users.md                   # ユーザーテーブル
├── tags.md                    # タグテーブル
├── tag_article_counts.md      # タグ別記事数
└── schema.json                # スキーマJSON
```

### 移植時のマッピング

| レガシー（DynamoDB）               | 新規（TiDB）              |
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
