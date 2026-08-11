# labs 機能（Zenn books 風ハンズオン教材）の GitHub 同期 + admin 閲覧

- 起票日: 2026-07-28
- 関連:
  - [GitHub webhook の非同期化](../2026-07-13-webhook-async-self-invoke/index.md)（articles 同期の現行フロー）
  - [logs 管理画面のアーキテクチャ決定](../2026-07-12-logs-admin-architecture/index.md)（admin.shuntaka.dev の基盤）
  - コンテンツ元: `~/repos/github.com/shuntaka9576/lab-backup-2026-0530`（旧 lab サイトのバックアップ）
- ステータス: 完了（2026-07-28 リリース 2026.0728.0 で prd 反映済み）

## 起票理由

CS 知識を蓄積するハンズオン教材（旧 lab サイト）を、Zenn の books のような「1 冊 = 複数チャプター」の形式で復活させたい。

旧構成（lab-backup-2026-0530）は Astro SPA + Cognito + CloudFront Signed URL の独立インフラで、コンテンツが `.astro` ファイルにハードコードされており執筆体験が悪く、インフラも本体と二重管理だった。今回は以下の方針で作り直す。

- コンテンツは **private リポジトリで MDX + 画像として管理**し、既存の articles と同じ GitHub Apps webhook 同期の仕組みで TiDB に取り込む
- 閲覧は **admin.shuntaka.dev/labs**。認証は既存 admin の Cognito セッション（同一オリジン Cookie）に相乗りするが、フロントは admin-web に同居させず**独立 SPA（マイクロフロントエンド）** として実装し、CloudFront のパスルーティングで合成する。独立認証基盤は作らない
- **画像は認証なしの公開配信でよい**（旧構成の Signed URL / DDB ACL のような保護はしない）。既存の `images.shuntaka.dev`（CloudFront + S3 OAC）の仕組みに載せる

## 現状整理

### 旧 lab-backup の資産（移植対象）

| 種別             | 場所                                             | 内容                                                                                                                                                                          |
| ---------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 本文             | `apps/lab-web/src/pages/**/*.astro`              | db（occ / write-skew / deadlock / deleted-at-index / glossary）、raft（overview / leader-election-minimal）、security の各ページ。本文が Astro コンポーネント内にハードコード |
| 画像             | `iac/site-assets/private/images/**`              | db / raft / security 配下に PNG 約 20 枚                                                                                                                                      |
| ハンズオンコード | `handson/raft/`（Rust crate ×2）、`handson/sql/` | チャプターから参照する演習・解答コード                                                                                                                                        |

旧構成のインフラ（Cognito / BFF / Signed URL / DDB ACL / Lambda@Edge）は**一切引き継がない**。

### 流用する既存の仕組み

- articles 同期: GitHub App webhook → `POST /webhooks/github`（署名検証 + push/main 判定のみ）→ 自己 Lambda Event invoke → `POST /events` で実処理。`apps/blog-api/api/src/handler/webhooks.rs`
- installation.id → `users.github_installation_id` でユーザー解決（`webhooks.rs:307` 付近）。lab リポジトリを**同じ GitHub App のインストールに追加**すれば installation.id は変わらず、この解決ロジックはそのまま使える
- Markdown → HTML 事前生成: `apps/blog-api/markdown` crate（comrak + syntect、Zenn 風記法）で同期時に `content_html` を生成し DB 保存（articles と同じ）
- admin 基盤: CloudFront（`admin.<fqdn>` / `images.<fqdn>` の 2 エイリアス）+ SPA（`apps/admin-web`）+ Hono API（`apps/admin-api`）+ Cognito SRP + セッション Cookie。`iac/aws/lib/admin/admin-stack.ts`

## 設計方針

| 論点                     | 決定                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| コンテンツリポジトリ     | 新規 private リポジトリを **stage ごとに 2 つ** 作成: `shuntaka9576/lab-contents-dev`（dev）/ `shuntaka9576/lab-contents`（prd）。webhook URL が各 stage の blog-api を向いている既存の stage 別 GitHub App のインストールに、対応するリポジトリを追加する（新規 App は作らない）。運用は lab-contents-dev で執筆・検証し、確定分を lab-contents へ反映                                                                                                                                 |
| リポジトリ判別           | webhook payload の `repository.full_name`（`PushEvent.repository` は取得済み）で分岐。blog-api に env `LAB_REPO_FULL_NAME` を追加し、一致したら lab 同期、それ以外は従来の articles 同期。値は stage ごとに dev: `shuntaka9576/lab-contents-dev` / prd: `shuntaka9576/lab-contents`（`GH_APP_ID` と同じく config.ts の envVarsSchema 経由で注入）                                                                                                                                       |
| フロント構成             | **マイクロフロントエンド**。labs リーダーは新規 SPA `apps/labs-web` として独立ビルド・独立デプロイし、admin CloudFront の `/labs/*` behavior で `admin.<fqdn>/labs` 配下に合成。admin-web への変更はナビリンク追加と login の returnTo 対応程度                                                                                                                                                                                                                                         |
| labs-web の FW           | **Svelte 5 + SvelteKit（adapter-static）**。admin-web（React + TanStack）とあえて別構造にし、新 FW の実験台を兼ねる。マイクロフロントエンドなので FW が違ってもオリジン合成に影響しない                                                                                                                                                                                                                                                                                                 |
| コンテンツ形式           | 拡張子は `.mdx` で統一（将来の本物 MDX 化に含みを残す。2026-07-28 決定）。ただし中身は当面**ブログと同じ Zenn 風 Markdown** として `markdown` crate で変換し、JSX コンポーネントは実行されない。インタラクティブ表現が必要になったら、まずブログの X 埋め込みと同じ「独自記法 → プレースホルダ div → labs-web 側で Svelte コンポーネントを hydration」方式で拡張する。本物の MDX（JS コンパイル必須）はレンダリングと同期アーキテクチャの再設計になるため、必要になった時点で別タスク化 |
| データモデル             | `labs`（本）+ `lab_chapters`（章）の 2 テーブルを TiDB に追加。FK なし・アプリ層整合（既存方針踏襲）                                                                                                                                                                                                                                                                                                                                                                                    |
| 章の順序                 | Zenn books と同じく `config.yaml` の `chapters:` 配列を正とする（ファイル名の数字プレフィックスに依存しない）                                                                                                                                                                                                                                                                                                                                                                           |
| 削除の扱い               | リポジトリから消えた lab / chapter は DB からハード削除（admin 閲覧専用なので影響範囲が閉じている）。articles の upsert-only とは異なる点に注意                                                                                                                                                                                                                                                                                                                                         |
| 画像の配信               | 認証なし公開。**新規 S3 バケット（AdminStack 所有・物理名固定 `<physicalPrefix>-lab-assets`）** + 既存 admin CloudFront に `/lab-assets/*` behavior を追加して `images.<fqdn>/lab-assets/...` で配信（`/labs/*` は labs SPA が使うためパスを分離。所有スタックの決定経緯は後述）                                                                                                                                                                                                        |
| 画像の同期               | webhook 同期時に blog-api が GitHub から取得し S3 に put（コピー。ソースオブトゥルースはリポジトリ）。GitHub blob sha を S3 オブジェクトメタデータ `github-sha` に記録して差分アップロード。本文書き換え後の画像 URL には `?v=<blob sha 先頭8桁>` を付与し、同名差し替え時も CloudFront invalidation なしでキャッシュが切り替わるようにする                                                                                                                                             |
| ベクトル検索 / embedding | 対象外。lab_chapters は PLaMO embedding チャンク生成をしない                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 公開サイトへの露出       | スコープ外。閲覧は admin のみ。将来ブログ本体に公開する場合は published フラグを使って別タスクで対応                                                                                                                                                                                                                                                                                                                                                                                    |
| ハンズオンコード         | 同リポジトリ `handson/` に置くが同期対象外。チャプター本文からは GitHub の blob URL で参照（markdown crate の GitHub 埋め込み記法がそのまま使える）                                                                                                                                                                                                                                                                                                                                     |

### マイクロフロントエンド構成の詳細

admin CloudFront（`admin.<fqdn>` / `images.<fqdn>` の 2 エイリアス、1 ディストリビューション）にパスで別 origin を足す、ルート単位の合成方式。module federation のようなランタイム統合はしない。

| パス            | origin                                       | 用途                          |
| --------------- | -------------------------------------------- | ----------------------------- |
| `default`       | admin-web SPA バケット（既存）               | 管理画面本体                  |
| `/api/*`        | API Gateway → admin-api（既存）              | labs の read API もここに追加 |
| `/images/*`     | moments 画像バケット（既存）                 | 変更なし                      |
| `/labs/*`       | **labs-web SPA バケット（新規）**            | labs リーダー SPA             |
| `/lab-assets/*` | **lab 画像バケット（新規、MainStack 所有）** | lab 教材画像（認証なし）      |

- labs-web は SvelteKit の `paths.base = '/labs'` + adapter-static（`fallback: 'index.html'`）でビルドし、専用バケットに独立デプロイ。admin-web と互いのリリースに影響しない
- 認証は同一オリジンなので既存のセッション Cookie（`__Host-session`）がそのまま `/api/*` に飛ぶ。labs-web は `/api/me` で判定し、未認証なら `/login?returnTo=/labs/...` へ遷移（ログイン画面は admin-web 側のまま。returnTo 対応だけ追加）
- CloudFront Function（HostGuardFunction）の SPA fallback rewrite を「`/labs/` 配下の拡張子なし URI → `/labs/index.html`、それ以外 → `/index.html`」に拡張。Host ガード（admin ホスト以外 403）は `/labs/*` にも適用する
- 将来 labs を公開サイト化する場合も、labs-web バケットを別ディストリビューション（例: labs.shuntaka.dev）に向け直すだけで済む

### 画像バケットの所有スタック（Phase C で MainStack → AdminStack に変更）

当初は「MainStack 所有 + AdminStack が props で受け取り behavior を張る」計画だったが、実装時に **CloudFront OAC はバケットポリシーに distribution ARN を書き戻す**ため、MainStack のバケット × AdminStack の distribution の組み合わせは相互参照（循環依存）になることが判明。以下の構成に変更した。

- バケットは **AdminStack 所有**（distribution と同一スタックなので OAC のポリシー付与が閉じる）
- バケット名は **物理名固定**（`<physicalPrefix>-lab-assets`）。blog-api（MainStack）の env `LAB_IMAGES_BUCKET_NAME` には config から同じ文字列を計算して渡すため、MainStack → AdminStack のクロススタック参照が発生しない
- blog-api Lambda への書き込み許可は、MainStack から Lambda ロール ARN を AdminStack に渡し、**AdminStack 側で iam.Policy をアタッチ**する（`lab-assets/*` への PutObject / GetObject。HeadObject は GetObject 権限で足りる）。依存方向は AdminStack → MainStack の一方向のみ

既存の moments 画像バケットを流用しない理由は従来どおり（bucketName がクロススタック token になり循環するため + prefix 運用の混在を避ける）。S3 キーと URL パスは 1:1 に揃える。

```
リポジトリ: labs/<lab-slug>/images/foo.png
S3 キー:    lab-assets/<lab-slug>/images/foo.png
URL:        https://images.shuntaka.dev/lab-assets/<lab-slug>/images/foo.png
```

## コンテンツリポジトリ構成（lab-contents / lab-contents-dev 共通）

```
labs/
├── db/
│   ├── config.yaml          # 本のメタ情報 + 章の順序
│   ├── occ.mdx              # 章（frontmatter に title）
│   ├── write-skew.mdx
│   ├── deadlock.mdx
│   ├── deleted-at-index.mdx
│   ├── glossary.mdx
│   └── images/              # この本の画像（サブディレクトリ可）
│       └── occ/snapshot-3-engines.png
├── raft/
│   ├── config.yaml
│   ├── overview.mdx
│   ├── leader-election-minimal.mdx
│   └── images/
└── security/
    ├── config.yaml
    ├── tanstack-npm-supply-chain.mdx
    └── images/
handson/                     # 同期対象外（章から GitHub リンクで参照）
├── raft/
└── sql/
```

### config.yaml スキーマ

```yaml
title: 'DB トランザクション演習'
summary: 'OCC / write skew / deadlock などを 3 エンジンで比較するハンズオン'
published: true # false なら admin 一覧でドラフト表示
chapters: # この順序が position になる。拡張子なしの slug
  - occ
  - write-skew
  - deadlock
  - deleted-at-index
  - glossary
```

### 章 frontmatter スキーマ

```yaml
---
title: '楽観的同時実行制御 (OCC)'
---
```

title のみ必須。章 slug はファイル名から拡張子を除いたもの（articles と同じ規則）。本文中の画像は `images/...` からの相対パスで書く（同期時に公開 URL へ書き換え）。

## ウィジェット記法（インタラクティブ表現）

旧 lab の StepRow / EnginePane（3 エンジン比較タブ）のような表現力を、Markdown ベースのまま失わないための仕組み。ブログの X 埋め込みと同じ「プレースホルダ + hydration」パターンを汎用化する。

記法（章の Markdown 内）:

```
:::widget engine-steps
num: 1
title: "A が BEGIN + UPDATE +10"
description: "..."
panes:
  mysql: { command: ..., output: ..., note: ..., result: ok|error|block|idle }
  postgres: ...
  dsql: ...
:::
```

変換の契約（プレビューの `extractWidgets` と本実装の markdown crate で共通）:

- `:::widget <name>` 〜 `:::` のブロックを `<div class="lab-widget" data-widget="<name>" data-payload="<base64(YAML)>"></div>` に置換する。ペイロードは Markdown として解釈しない
- labs-web 側は `content_html` 描画後に `.lab-widget[data-widget]` を走査し、`src/lib/widgets/hydrate.ts` のレジストリにあるウィジェットへ Svelte コンポーネント（`mount()`）を差し込む。章遷移時は cleanup で `unmount()`
- 未知のウィジェット名は console.warn のみで無視（前方互換）。ブログ側は hydration しないので影響なし
- 第一号は `engine-steps`（`src/lib/widgets/EngineSteps.svelte`）。新ウィジェットはレジストリに追加するだけ

執筆時の注意: YAML のブロックスカラーで 1 行目の先頭に空白がある場合（psql 出力の ` id | ...` など）は、インデント指示子つき `|2-` を使わないと 2 行目以降でブロックが途切れる。

## 同期フロー

```
push (main) → POST /webhooks/github
  → 署名検証 + push/main 判定（既存 screen_push_event）
  → repository.full_name == LAB_REPO_FULL_NAME なら kind=lab の封筒で自己 Event invoke
  → POST /events → process_lab_push_event
      1. installation token 取得（既存 GithubClient）
      2. Git Trees API (GET /repos/{o}/{r}/git/trees/{head}?recursive=1) で labs/ 配下を一括列挙
         ※ articles 同期の contents API 方式と異なり、ネストした images/ を 1 リクエストで拾うため
      3. lab ごとに config.yaml を取得・パース
      4. 画像: S3 HeadObject でメタデータ github-sha を比較し、差分のみ PutObject
      5. 章: .mdx / .md を取得 → frontmatter パース → 画像相対パスを
         {IMAGES_BASE_URL}/lab-assets/<lab-slug>/images/...?v=<sha8> に書き換え → markdown crate で HTML 変換
      6. labs / lab_chapters に upsert（content 不変なら HTML 再生成スキップ、articles と同じ差分判定）
      7. リポジトリに存在しない lab / chapter の行を削除
```

- 章数が増えても articles と同様に全件フルスキャン + 冪等 upsert。10 秒制約は自己 invoke で既に回避済み
- 画像取得は contents API の base64（1MB 超は `Accept: application/vnd.github.raw`）を使う
- 同期対象は `labs/` 配下のみ。`handson/` 等の変更でも webhook は飛ぶが、冪等なので差分なしで完走する

## DB スキーマ案

`tools/dsql-cli/dsl-tidb/schema/` に追加（既存スタイル踏襲: FK なし、CHECK なし、`${SCHEMA}` プレースホルダ）。

`10_labs.sql`

```sql
CREATE TABLE IF NOT EXISTS `${SCHEMA}`.`labs` (
  `lab_id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `user_id` CHAR(36) NOT NULL,
  `slug` VARCHAR(255) NOT NULL,
  `title` VARCHAR(500) NOT NULL,
  `summary` TEXT NULL,
  `published` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`lab_id`),
  UNIQUE KEY `uq_labs_slug` (`slug`),
  KEY `idx_labs_user_id` (`user_id`)
);
```

`11_lab_chapters.sql`

```sql
CREATE TABLE IF NOT EXISTS `${SCHEMA}`.`lab_chapters` (
  `chapter_id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `lab_id` CHAR(36) NOT NULL,
  `slug` VARCHAR(255) NOT NULL,
  `title` VARCHAR(500) NOT NULL,
  `position` INT NOT NULL,
  `content` LONGTEXT NOT NULL,
  `content_html` LONGTEXT NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`chapter_id`),
  UNIQUE KEY `uq_lab_chapters_lab_slug` (`lab_id`, `slug`),
  KEY `idx_lab_chapters_lab_position` (`lab_id`, `position`)
);
```

適用は既存運用どおり個別に `sed 's|${SCHEMA}|blog_dev|g' schema/10_labs.sql | mysql -h tidb.$TAILNET ...`（`load.sh` 全実行は 04 の ALTER が非冪等なので不可）。適用後 `docs/` で `bun run doc-gen`（tbls）。

## 変更対象コンポーネント

### blog-api（Rust）

| crate          | 変更                                                                                                                                                                                                     |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| shared         | `WebhookConfig` に `lab_repo_full_name` / `lab_images_bucket` を追加（`shared/src/config.rs`）                                                                                                           |
| kernel         | `model/lab.rs`（Lab / LabChapter / LabConfig / ChapterFrontmatter）、`repository/labs.rs` trait                                                                                                          |
| infrastructure | `github/client.rs` に Trees API + raw blob 取得を追加。`s3/` モジュール新設（`aws-sdk-s3`。self-invoke で `aws-sdk-lambda` 実績があるので依存追加は自然）                                                |
| adapter        | `repository/labs.rs`（upsert / delete_missing / list）                                                                                                                                                   |
| api            | `handler/webhooks.rs` に repository 分岐 + `process_lab_push_event`。封筒 `GithubPushEnvelope` に kind を追加済みの構造をそのまま利用                                                                    |
| markdown       | `:::widget <name>` コンテナ → プレースホルダ div 変換を追加（プレビューの `extractWidgets` と同一契約。ペイロードは Markdown 解釈せず base64 で通す）。wasm 再ビルドで preview / nvim プラグインにも波及 |

### iac/aws（CDK）

- MainStack: lab 画像用 S3 バケット新設（OAC 前提、パブリックブロック維持）、blog-api Lambda に `grantPut`、env `LAB_REPO_FULL_NAME` / `LAB_IMAGES_BUCKET_NAME` 追加（`IMAGES_BASE_URL` は設定済み: `iac/aws/lib/api/blog-api-construct.ts:214`）
- AdminStack:
  - labs-web SPA 用 S3 バケット新設 + `BucketDeployment`（`apps/labs-web/dist`。admin-web の SpaDeployment とはバケットを分け、互いの deploy が prune し合わないようにする）
  - `additionalBehaviors['/labs/*']` → labs-web SPA バケット（OAC）。HostGuardFunction（Host ガード + SPA fallback rewrite の `/labs/index.html` 対応）をアタッチ
  - `additionalBehaviors['/lab-assets/*']` → lab 画像バケット（MainStack から props で受領、OAC）。ガード関数なし（`/images/*` と同じ公開扱い）
- bin/cdk.ts: mainStack → adminStack へ lab 画像バケットを props 渡し（作成順そのまま、循環なしを synth で確認）

### admin-api（Hono）

- `db/types.ts` に `labs` / `lab_chapters` テーブル型を追加
- `routes/labs.ts` 新設（既存 auth middleware 配下、read-only）
  - `GET /api/labs` — 一覧（slug, title, summary, published, 章数, updated_at）
  - `GET /api/labs/:slug` — 本の詳細 + 章一覧（slug, title, position）
  - `GET /api/labs/:slug/chapters/:chapterSlug` — 章本文（content_html）

### labs-web（新規 SPA / マイクロフロントエンド、Svelte 5）

- `apps/labs-web` を新設。**Svelte 5（runes）+ SvelteKit + adapter-static + Tailwind CSS 4**。SSR はしない（全ルート `export const ssr = false` の SPA 構成、`fallback: 'index.html'`）
- `svelte.config.js` で `paths.base = '/labs'`。ルートは `routes/+page.svelte`（一覧）/ `routes/[labSlug]/+page.svelte`（章一覧）/ `routes/[labSlug]/[chapterSlug]/+page.svelte`（リーダー）
- リーダー画面は左サイドバーに章ナビ + 前後章リンク（Zenn books 風）。本文は `content_html` を `{@html}` で描画
- 記事 HTML 用 CSS: syntect がインラインスタイルを吐くか確認の上、apps/web の記事表示スタイルから必要分を labs-web に移植。Svelte の scoped CSS とは分けてグローバル CSS として持つ（`{@html}` 部分にはスコープが効かないため）
- 認証・API クライアントは admin-web の実装（`/api/me` 判定、Cookie 前提の fetch、401 で `/login?returnTo=` へ）を参考に Svelte 用へ小さく書き直す。fetch ラッパー程度なので FW 横断の共有パッケージ化はしない
- コード品質チェック: oxlint は `.svelte` を見ないため、labs-web には `svelte-check` + `prettier-plugin-svelte` を導入し、workspace の `check` タスク（Turbo）に `svelte-check` をぶら下げる。cspell は既存設定のまま対象に含める

### admin-web（既存、最小変更）

- ナビに labs へのリンク追加（`<a href="/labs/">`。SPA が別物なのでフルページ遷移）
- login ページに `returnTo` クエリ対応を追加（同一オリジンのパスのみ許可）

## 実装フェーズ

- [x] Phase 0: ローカルプレビュー（`apps/labs-web` の Svelte プロトタイプ + モック API で Zenn books 風リーダーの体験確認。DB・同期・CDK には触れない）

  ```sh
  # ルートの `bun run dev` (turbo) に labs-web も含まれる。
  # labs-web の dev タスク (preview/dev.ts) がモック API と vite を両方起動する。
  # 単体起動なら:
  cd apps/labs-web && bun run dev        # API + vite (個別は dev:api / dev:web)
  # ポートは worktree ごとに .env.local で採番。bun run port の labs-web 行の URL を開く
  # (main worktree の既定は labs-web: 43006 / labs-api: 43007)
  ```

- [x] Phase A: DB スキーマ追加（10/11 SQL 作成 → blog_dev 適用 → tbls doc-gen）
- [x] Phase B: blog-api の lab 同期実装（config / 分岐 / Trees API / S3 / 変換 / upsert・delete）+ ユニットテスト
- [x] Phase C: CDK 変更（バケット / grant / env / CloudFront behavior）→ dev デプロイ
- [x] Phase D: コンテンツリポジトリ `lab-contents-dev` / `lab-contents` 作成、lab-backup から db / raft / security を MDX 化して lab-contents-dev へ移植（画像パスを `images/...` 相対に統一、handson コードも同 repo へ）
- [x] Phase E: dev 用 GitHub App のインストールに `lab-contents-dev` を追加 → push して dev（blog_dev / shuntaka.tech）で同期確認
      ※ 必ず Phase C（分岐デプロイ）の後。先にインストールすると lab の push が articles 同期として走り、Event invoke がエラーリトライする
- [x] Phase F: admin-api の labs read API + `apps/labs-web` 新設（Svelte 5 + SvelteKit adapter-static、CloudFront `/labs/*` 合成、admin-web は returnTo 対応とナビリンクのみ）
- [x] Phase G: prd 反映（blog_prd DDL → デプロイ → prd 用 GitHub App に `lab-contents` を追加 → 同期・表示確認）、開発ドキュメント（01_development.md）への手順追記

## スコープ外（将来タスク候補）

- MDX の JSX コンポーネント実行（インタラクティブ教材）
- ブログ本体（shuntaka.dev）への lab 公開、全文検索・ベクトル検索への組み込み
- S3 上の孤児画像のクリーンアップ（削除章の画像は当面残置）
- 旧 lab-backup リポジトリ・旧 AWS リソース（LabSite スタック群）の後片付け

## 本番適用手順（Phase G）

dev で全フェーズ検証済みの状態から prd へ反映する手順。順序厳守（特に手順 5 は 4 のデプロイ完了後）。

### 1. blog_prd へ DDL 適用

```sh
export TAILNET=$(tailscale status --json | jq -r '.MagicDNSSuffix')
cd tools/dsql-cli/dsl-tidb
sed 's|${SCHEMA}|blog_prd|g' schema/10_labs.sql | mysql -h tidb.$TAILNET -P 4000 -u root
sed 's|${SCHEMA}|blog_prd|g' schema/11_lab_chapters.sql | mysql -h tidb.$TAILNET -P 4000 -u root

# 確認
mysql -h tidb.$TAILNET -P 4000 -u root -e 'SHOW CREATE TABLE blog_prd.labs\G SHOW CREATE TABLE blog_prd.lab_chapters\G'
```

CREATE TABLE IF NOT EXISTS のみで冪等。既存テーブルへの ALTER は無いため blog_prd の他テーブルに影響しない。

### 2. PR #733 を Ready 化してマージ

マージで main push → dev CDK の自動デプロイが走る（デプロイ済み内容と同一なので冪等）。

### 3. tagpr リリース PR のマージ（人間が実施）

main マージ後に tagpr が作成・追従するリリース PR（`tagpr` ラベル付き）をマージすると、CalVer タグ → prd CDK（st-tidb-proxy → main → admin の順）→ Vercel 本番の順にデプロイされる。prd 側に入るもの:

- p-st-main: blog-api に `LAB_REPO_FULL_NAME=shuntaka9576/lab-contents` / `LAB_IMAGES_BUCKET_NAME=p-st-lab-assets`
- p-st-admin: LabImagesBucket（p-st-lab-assets、RETAIN）/ LabsSpaBucket + labs-web SPA / `/labs/*` `/lab-assets/*` behavior / labs read API 入り admin-api

### 4. prd デプロイの完了確認

```sh
gh run list --workflow=tagpr.yaml --limit 1   # または Actions 画面
curl -s -o /dev/null -w '%{http_code}\n' https://admin.shuntaka.dev/labs/        # 200
curl -s -o /dev/null -w '%{http_code}\n' https://admin.shuntaka.dev/api/labs     # 401 (認証必須)
```

### 5. prd 用 GitHub App に lab-contents を追加（人間が実施）

GitHub Settings → Developer settings → GitHub Apps → prd 用 App（webhook URL が api.shuntaka.dev のもの）→ Install App → Repository access に `lab-contents` を追加。installation_id は変わらないため users テーブルの更新は不要。**必ず手順 4 の完了後に行う**（先に追加すると push が articles 同期として走りエラーリトライになる）。

### 6. lab-contents へコンテンツを push

dev で検証済みの lab-contents-dev の内容をそのまま prd リポジトリへ push する。

```sh
cd ~/repos/github.com/shuntaka9576/lab-contents-dev
git remote add prd git@github.com:shuntaka9576/lab-contents.git   # 初回のみ
git push prd main
```

以後の運用も同じ流れ（lab-contents-dev で執筆・dev 確認 → 確定分を `git push prd main`）。公開したい本は config.yaml の `published: true` を忘れずに。

### 7. prd 同期の確認

```sh
mysql -h tidb.$TAILNET -P 4000 -u root -e "SELECT l.slug, l.published, COUNT(c.chapter_id) FROM blog_prd.labs l LEFT JOIN blog_prd.lab_chapters c ON c.lab_id = l.lab_id GROUP BY l.slug, l.published ORDER BY l.slug;"
curl -s -o /dev/null -w '%{http_code}\n' 'https://images.shuntaka.dev/lab-assets/001-db-transaction-exercises/images/deadlock/deadlock-compare.png'  # 200
```

ブラウザで https://admin.shuntaka.dev/labs/ にログインして一覧・章・画像・engine-steps ウィジェットを確認。

### 切り戻し

- 同期を止める: prd 用 App の Repository access から lab-contents を外す（既存の articles 同期には影響なし）
- 表示を消す: lab-contents 側で labs/ 配下を空にして push すれば全 lab がハード削除される。テーブル自体は残しても他機能に影響なし
- インフラの切り戻しは通常のリリースフロー（revert PR → タグリリース）に従う

## 作業ログ

### 2026-08-12

- ローカルプレビューで本番反映前の `lab-contents` を直接確認できるよう、`preview/server.ts` の `LAB_CONTENTS_DIR` 未指定時の参照先を `~/repos/github.com/shuntaka9576/lab-contents-dev` から `~/repos/github.com/shuntaka9576/lab-contents` へ変更。必要な場合は引き続き `LAB_CONTENTS_DIR` で任意のリポジトリルートに切り替え可能

### 2026-07-28（Phase G / リリース）

- blog_prd へ DDL 適用（labs / lab_chapters）
- PR #733 をマージ後、リリース 2026.0728.0（PR #737）で prd デプロイ。blog_prd に 3 labs / 8 章同期、images.shuntaka.dev/lab-assets の画像配信 200、admin.shuntaka.dev/labs/ 200 / /api/labs 401 を確認
- チェンジログ整理のハマりどころ: 当初、リリース PR の不要項目を除くために CalVer タグを手動で打ったが、これは **tagpr が管理する成果物の模倣**で、tagpr の追従状態を壊す悪手だった（置き去りリリース PR #717 と重複 PR #736 が発生し、いずれもクローズして手動タグも削除）。正解は `.github/release.yml` の除外設定を使い、**対象 PR に `skip-changelog` ラベルを付けて tagpr を再実行する**だけ。tagpr まわりはタグ・リリース PR を手で作らず、ラベル操作と再実行のみで扱うこと

### 2026-07-28

- 起票。lab-backup-2026-0530 の資産棚卸しと、articles 同期・admin 基盤・DB スキーマの現状調査を実施し本計画を作成
- フロント構成を admin-web 同居からマイクロフロントエンド（`apps/labs-web` を新設し CloudFront `/labs/*` behavior でパス合成）に変更。これに伴い lab 画像の配信パスを `/labs/*` → `/lab-assets/*` に変更（`/labs/*` は SPA が使用）
- labs-web の FW を **Svelte 5 + SvelteKit（adapter-static）** に決定。admin-web（React + TanStack）とあえて別構造にして新 FW の実験台を兼ねる。候補比較は Svelte 5 / SolidStart / TanStack Start SPA mode / Qwik City の 4 つで実施
- コンテンツリポジトリ名を stage 別の 2 本（dev: `lab-contents-dev` / prd: `lab-contents`）に決定。webhook URL が stage ごとの blog-api を向いている既存の GitHub App 構成に合わせる
- 実装順を変更し、本実装の前に **Phase 0: ローカルプレビュー**（labs-web プロトタイプ + モック API）で UI と読書体験を先に確認することにした
- Phase 0 を実装。`apps/labs-web` に SvelteKit（Svelte 5 runes / adapter-static / `paths.base='/labs'` / Tailwind 4）の 3 画面（一覧・章一覧・リーダー）と、`preview/server.ts`（Bun + Hono。admin-api に将来実装する labs read API と同じ契約で、`preview/contents/labs/` を packages/markdown-wasm で変換して返すモック）を追加。サンプルとして lab-backup から raft の 2 章（フル変換）+ db の 2 章（抜粋）+ 画像 10 枚を計画のリポジトリ構成（config.yaml + mdx + images/）どおりに配置
- 動作確認済み: 章サイドバー・前後章ナビ、`rust:src/lib.rs` 形式のファイル名タブ + syntect ハイライト、`:::message` / `:::message alert` / `:::details`、テーブル、画像の `/lab-assets/*` 配信（相対 `images/` 参照の書き換え）。記事 CSS は apps/web の globals.css から prose / message / code-block / link-card / github-embed を `src/article.css` に抽出して流用
- 同期時の画像 URL に `?v=<blob sha 先頭8桁>` を付与する方針を追記（同名差し替え時の CloudFront キャッシュ対策。invalidation 不要になる）
- 補足: svelte-check と bun-types が衝突するため labs-web の tsconfig は `types: []` とし、`preview/server.ts` 側に `/// <reference types="bun" />` を置いた
- ポート管理に組み込み: `.config/wt.toml`（pre-start の `.env.local` 生成 + post-remove kill）と `scripts/port.sh` に `LABS_WEB_PORT`（main 既定 43006）/ `LABS_API_PORT`（同 43007）を追加。vite.config.ts / preview/server.ts は env からポートを読む。既存 worktree への反映は `wt hook pre-start env --dry-run` でレンダリング値を確認して `.env.local` に追記（フック本実行は approval が要るため）
- ルート `bun run dev`（turbo）が labs-web の dev タスクを拾うようになったため、`dev` スクリプトを `preview/dev.ts`（モック API を同一プロセスで起動 + vite dev を子プロセス起動、SIGINT/SIGTERM 転送）に変更。vite 単体は `dev:web`。turbo からの起動・シグナル終了時の両ポート解放を確認済み
- UI は Phase 0 プレビューで承認。コンテンツ形式は「.mdx 拡張子のまま、中身は当面 Zenn 風 Markdown（JSX 非実行）」で確定。インタラクティブ表現はプレースホルダ + Svelte hydration 方式を第一候補、本物の MDX 化は必要時に別タスクとする
- 「旧 lab の表現力を失いたくない」という要望を受けて、ウィジェット記法（`:::widget`）を設計しプレビューに実装。第一号として旧 StepRow / EnginePane 相当の `engine-steps`（3 エンジンタブ切り替え、command / output / note / 結果バッジ）を Svelte で再現し、occ 章を旧 lab の実データで全 7 ステップ移植して動作確認した。プレビューは `preview/server.ts` の JS 変換で実現しており、本実装では同一契約を markdown crate（Rust）に移す（Phase B）
- ハマりどころ: YAML ブロックスカラーの 1 行目が先頭空白つき（psql 出力）だとインデント自動判定が 7 になり以降の行で途切れる。`|2-` の明示で解決（執筆ガイドとして記録）
- Phase A 完了。`schema/10_labs.sql` / `11_lab_chapters.sql` を作成し blog_dev に個別適用（`sed 's|${SCHEMA}|blog_dev|g' schema/1X_*.sql | mysql -h tidb.$TAILNET -P 4000 -u root`）。`updated_at` は moments と同じ `ON UPDATE CURRENT_TIMESTAMP(6)` 方式を採用。tbls doc-gen 済み（05_db/labs.md / lab_chapters.md 生成）
- markdown crate に `:::widget` 変換を実装（`process_widgets`。全前処理の最前段で実行し、ペイロードを他の前処理に触れさせない。base64 は標準エンコード）。cargo test -p markdown 66 pass / clippy クリーン / wasm pkg 再生成 + markdown-wasm テスト 21 pass。これに伴い preview/server.ts の JS 版 extractWidgets を撤去し、プレビューも crate 実装（wasm 経由）で変換する構成に一本化（occ 章 7 ウィジェットの変換を確認済み）
- プレビューのサンプルコンテンツ（labs/ の mdx + 画像 10 枚）をモノレポから `~/repos/github.com/shuntaka9576/lab-contents-dev`（ローカル git リポジトリ、初期コミット済み）へ移設。preview/server.ts は `LAB_CONTENTS_DIR`（既定: ghq 配置の lab-contents-dev）を参照する構成に変更し、モノレポにはコンテンツ・画像を置かない形に是正。GitHub 上の private リポジトリ作成と push は Phase D で実施
- Phase C 着手時に OAC の循環依存を発見し、lab 画像バケットの所有を MainStack → AdminStack に変更（詳細は「画像バケットの所有スタック」セクション）
- Phase C のコード実装完了（dev デプロイ前まで）。config に `labs.contentsRepoFullName` / `labs.imagesBucketName`（`<prefix>-lab-assets`）を stage 別に追加、blog-api Lambda に env 2 個注入 + ロール ARN 公開、AdminStack に LabImagesBucket / LabsSpaBucket / `/labs/*` `/lab-assets/*` behavior / BlogApiLabAssetsPolicy / HostGuardFunction 拡張（`/labs` → `/labs/` 301、`/labs/*` の SPA fallback）。labs-web の build 成果物が無い場合は addWarning でスキップ（CI 整備までの暫定。admin-web の addError は維持）。スナップショット差分は加算のみで既存リソースの変更・置換なし、`d-st-admin` → `d-st-main` の一方向依存を manifest で確認
- lint 整備: `docs/scripts/check-search.ts` の floating promise を修正（labs-web workspace 追加の bun install で型定義が更新され顕在化した既存問題）、cspell 辞書に splitn / tinyint / handson / qwik を追加。ルート `bun run lint` グリーン
- デプロイ方針: PR はマージせず、`deploy.yaml` の workflow_dispatch（ref: PR ブランチ / stageName=dev / stack=all）で PR の状態のまま dev に反映して動作確認する。reusable-deploy の admin ステップに labs-web ビルドを追加
- 7 コミットに分割して push、Draft PR #733（`feat/labs`）を作成。ブランチを lab-combine → feat/labs にリネームした際、GitHub のブランチリネームで PR #732 が CLOSED になったため作り直した（リネームは PR 作成前に行うこと）。workflow_dispatch で dev デプロイを起動
- Phase D 完了。db 全 5 章の完全移植（occ 深掘り復元 / write-skew 完全版差し替え / deadlock / deleted-at-index / glossary、engine-steps ウィジェット計 34 個）、security 事例集 1 章、handson コード（Rust workspace、solution のテスト pass 確認済み）を lab-contents-dev へ。あわせて lab slug の命名規則を **連番 + 説明的 kebab 名**（`001-db-transaction-exercises` / `002-raft-minimal-implementation` / `003-security-incident-cases`）に決定。一覧 API が slug 昇順のため連番がそのまま表示順になる。リネームは同期の「旧 lab 削除 + 新規作成」で自然に反映されることを dev で確認（旧プレフィックスの S3 画像は設計どおり孤児として残置）
- Phase F 完了。admin-api に read-only の labs ルート 3 本（sessionAuth 配下、Kysely 手書き型追加）、labs-web に 401 → `/login?returnTo=` フルページ遷移、admin-web に returnTo 対応（同一オリジンパスのみ）と labs ナビリンクを実装し dev デプロイ。`/api/labs` が 404 → 401 に変わったことを確認。未ログインで `/labs/` を開くとログイン画面へ誘導され、ログイン後に戻る動線が繋がった
- Phase E 完了。lab-contents-dev / lab-contents の private リポジトリを作成し、dev 用 GitHub App にインストール後の push で E2E 同期を確認（blog_dev に labs 2 件 / lab_chapters 4 件、S3 に画像 10 枚、images.shuntaka.tech/lab-assets/ で全画像 200）。ハマりどころ 2 件: (1) 新設の S3 クライアントが proxy 反映済み config を使っておらず `infrastructure::aws::load_sdk_config()` に共通化。(2) 真因は **s3:ListBucket が無いロールの HeadObject は存在しないキーに 404 ではなく 403 を返す S3 仕様**で、未アップロード判定に入れず全画像スキップになっていた。ListBucket（prefix 条件付き）のポリシー追加 + head 失敗時はアップロード試行にフォールバックする二段構えで解消
- dev デプロイ完了（Phase C 完了）。ハマりどころ 2 件: (1) adminStack が mainStack に依存したことで、admin デプロイの synth でも main stack の env 未設定エラー注釈が効くようになり、reusable-deploy の admin ステップに GH_APP_ID 等の env を追加して解消。(2) CloudFront の `/labs/*` behavior は URI をそのまま S3 キーとして転送するため、labs SPA は `destinationKeyPrefix: 'labs'` で labs/ 配下に配置する必要があった（直下配置だと 403）。`admin.shuntaka.tech/labs/` 200 / `/labs` → `/labs/` 301 を確認
- Phase B 完了。kernel（model/lab.rs, repository/labs.rs）/ adapter（repository/labs.rs）/ infrastructure（github: Trees API recursive + raw blob 取得、s3: aws-sdk-s3 で `github-sha` メタデータ差分アップロード）/ api（`process_lab_push_event`、画像 URL 書き換え、削除同期）を実装。cargo test 全 150 件 pass / clippy -D warnings クリーン（レビュー側でも独立に再実行して確認）
- 設計判断（実装時の発見による逸脱）: `GithubPushEnvelope.kind` は従来「封筒スキーマ識別のマジック値」だったが、articles/labs のルーティング用途に転用した。`/events` 側は kind == "labs" のみ labs 分岐、それ以外は articles にフォールバック（旧デプロイの in-flight 封筒も従来挙動で処理される）。kind の厳密一致チェックは撤去したが、安全性は封筒内 HMAC 署名の再検証（分岐前に実施）が引き続き担保する
- 削除セマンティクス: lab は「labs/<slug>/ 配下が tree に存在するか」、章は「参照ファイルが tree に存在するか」を keep 基準とし、フェッチ失敗やパース失敗など一時エラーでは削除しないフェイルセーフにした（hard delete 導入に伴う誤削除防止）
- 運用メモ: 実装中にホストのディスクが枯渇（残 232MiB）し、この worktree の `target/`（25GB 超）を cargo clean で解放した。検証ビルド後の空きは 2.6GB とタイト。次の大物候補は main worktree の `target/`（15GB、再生成可能）
