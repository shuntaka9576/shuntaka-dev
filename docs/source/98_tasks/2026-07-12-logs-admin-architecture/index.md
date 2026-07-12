# logs 管理画面（admin.shuntaka.dev）のアーキテクチャ決定と実装計画

- 起票日: 2026-07-12
- 関連: [logs 機能の構想と UI モック](../2026-07-12-logs-feature/index.md)
- ステータス: 計画（実装未着手）

## 決定事項

logs の投稿用管理画面。Cloudflare Workers + R2 案は **廃案**（Workers custom domain に DNS ゾーン移管が必要なため）、オール AWS の CloudFront 構成に決定。

| 論点        | 決定                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ドメイン    | prd: `admin.shuntaka.dev` / dev: `admin.shuntaka.tech`（`iac/aws/lib/config.ts` の fqdn に従い stage 単位）                                                                                                                                                                                                                                                                             |
| 配信        | CloudFront 1 ディストリビューション。default → 管理画面 SPA（S3, OAC）/ `/api/*` → API Gateway HTTP API（→ VPC Lambda）/ `/images/*` → 画像 S3（OAC）                                                                                                                                                                                                                                   |
| 管理画面 FE | React 19 + Vite + TanStack Router（file-based）/ Query / Form + zod + Tailwind CSS 4 + shadcn/ui + FSD 構成                                                                                                                                                                                                                                                                             |
| API         | Hono（`@hono/zod-openapi` の `OpenAPIHono`）+ Hono RPC（`hc<AppType>` を workspace 型共有）+ `hono/aws-lambda`。Node.js 22 / ARM64 / esbuild バンドルの VPC Lambda                                                                                                                                                                                                                      |
| TiDB 接続   | 既存 tidb-proxy VPC の private subnet に Lambda を配置し、`tidb-proxy.internal:13306` 経由で `blog_dev` / `blog_prd` に接続。外部 HTTPS は squid（3128）forward proxy 経由（blog-api と同じ SG パターン）                                                                                                                                                                               |
| ORM         | **Kysely**（MySQL dialect + mysql2）。DDL は既存の `tools/dsql-cli/dsl-tidb/schema/`（`${SCHEMA}` 注入 + `load.sh`）流儀で管理し、Kysely はクエリビルダとして利用                                                                                                                                                                                                                       |
| 認証        | Cognito User Pool + **USER_SRP_AUTH**（`amazon-cognito-identity-js`、SPA 内の自前ログインフォーム。Hosted UI は使わない）。トークンはブラウザに持たせず `POST /api/auth/login` で検証（`jose`）→ セッション実体は TiDB `admin_sessions` に保存し、**暗号化 HttpOnly Cookie**（本番 `__Host-session`, `Secure`, `SameSite=Lax`）にはセッション ID のみ格納。refresh はサーバ側で透過実行 |
| OpenAPI     | `@hono/zod-openapi` の `createRoute` でスキーマ定義。`/openapi.json` + Scalar（`@scalar/hono-api-reference`）の `/doc` は **ローカル開発サーバ限定**                                                                                                                                                                                                                                    |
| 画像        | クライアント側で圧縮（canvas → WebP）→ `/api` で presigned PUT URL 発行 → S3 へ直接 PUT → 配信は CloudFront `/images/*`（エッジキャッシュ）                                                                                                                                                                                                                                             |

## 構成図

```
Browser (admin SPA)
  │ ① ログイン: Cognito USER_SRP_AUTH（public client）→ トークンを POST /api/auth/login へ
  │ ② API: 暗号化 HttpOnly セッション Cookie（__Host-session, SameSite=Lax）を自動送信
  │ ③ 画像: presigned PUT で S3 直アップロード（アップロード前にクライアントで WebP 圧縮）
  ▼
CloudFront (admin.shuntaka.dev, ACM us-east-1)
  ├─ default    → S3: admin SPA（OAC, CloudFront Function で SPA fallback）
  ├─ /api/*     → API Gateway HTTP API → Lambda
  │                 └ Hono + Kysely（VPC: tidb-proxy private subnet）
  │                     ├ tidb-proxy.internal:13306 →（Tailnet）→ TiDB blog_{stage}
  │                     └ squid :3128（外部 HTTPS が必要になった場合の forward proxy）
  └─ /images/*  → S3: images バケット（OAC, 長め TTL）
                     ▲ presigned PUT（クライアント直アップロード, CORS で admin オリジン許可）
```

公開側（shuntaka.dev の logs タブ）は従来どおり blog-api（Rust, api.shuntaka.dev）から読む。画像 URL は `https://admin.shuntaka.dev/images/...` を返す（`<img>` 読み込みなので CORS 不要。公開コンテンツを admin ドメインで配ることに抵抗が出たら `images.shuntaka.dev` の別 A レコードを同 CloudFront に足すだけで分離可能）。

## リポジトリ構成（追加分）

```
apps/
├── admin-web/      # 管理画面 SPA (Vite + React 19, FSD)
│   └── src/{app,pages,widgets,features,entities,shared}/
├── admin-backend/  # Hono + Kysely (esbuild → Lambda, dev は @hono/node-server)
│   └── src/{routes,db,auth,schemas}/ + dev.ts（Scalar /doc はここだけ）
iac/aws/lib/
├── dns/virginia-certificate-stack.ts   # us-east-1 ACM（CloudFront 用。新設）
└── admin/admin-stack.ts                # Cognito + Lambda + S3×2 + CloudFront + Route53
```

- パッケージ管理は本リポジトリの流儀（Bun workspaces + Turbo、Vite+ (oxlint/oxfmt)、cspell）に合わせる
- `apps/admin-web` は `apps/admin-backend` を `workspace:*` で type-only import し、`hc<AppType>` で end-to-end 型共有
- Vite dev proxy: `/api` → `http://localhost:3001`（本番は CloudFront が同じパス構造を再現）

## API 設計（初期エンドポイント）

Hono は `basePath('/api')` で組む（CloudFront 側で prefix strip をしない。CF Function を減らすため）。

| Method / Path              | 内容                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/login`     | SRP で得たトークンを検証してセッションを保存し、暗号化 HttpOnly Cookie を発行（認証不要の唯一のルート） |
| `POST /api/auth/logout`    | セッション削除 + Cognito `RevokeToken` + Cookie 破棄                                                    |
| `GET /api/me`              | セッション検証の疎通確認（FE の auth guard 用）                                                         |
| `GET /api/logs`            | 一覧（cursor ページング: `published_at` + `log_id`）                                                    |
| `POST /api/logs`           | 作成。`{ text(≤180), imageKey, fastener('clip'\|'tape'), fastenerColor?, publishedAt? }`                |
| `PATCH /api/logs/:id`      | 更新                                                                                                    |
| `DELETE /api/logs/:id`     | 削除                                                                                                    |
| `POST /api/images/presign` | presigned PUT URL 発行。`{ contentType: 'image/webp', contentLength }` → `{ url, imageKey }`            |

- バリデーションエラーは `OpenAPIHono` の `defaultHook` で 400 に統一
- 認証ミドルウェア: セッション Cookie を unseal（sid）→ `admin_sessions` からトークンを取得し、access token を `jose` で検証（issuer / `token_use === 'access'` / `client_id`）。失効間近ならサーバ側で refresh してレコードを更新。加えて Origin allowlist + `X-Requested-With` の簡易 CSRF チェック

## DB スキーマ（`dsl-tidb/schema/` に追加）

```sql
CREATE TABLE `${SCHEMA}`.`logs` (
  `log_id`         VARCHAR(26)  NOT NULL,               -- ULID
  `user_id`        VARCHAR(36)  NOT NULL,
  `text`           VARCHAR(180) NOT NULL,
  `image_key`      VARCHAR(255) NOT NULL,               -- images バケットの key
  `fastener`       ENUM('clip','tape') NOT NULL DEFAULT 'clip',
  `fastener_color` ENUM('pink','blue','yellow','green') NULL,
  `status`         ENUM('published','draft') NOT NULL DEFAULT 'published',
  `published_at`   DATETIME(6)  NULL,
  `created_at`     DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`     DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`log_id`),
  KEY `idx_logs_feed` (`user_id`, `status`, `published_at`, `log_id`)
);
```

セッション実体（Cognito トークン一式）は Cookie ではなく DB に置く（Cookie 4KB 上限対策 + 失効管理のため）。

```sql
CREATE TABLE `${SCHEMA}`.`admin_sessions` (
  `sid`           VARCHAR(64) NOT NULL,
  `access_token`  TEXT        NOT NULL,
  `id_token`      TEXT        NOT NULL,
  `refresh_token` TEXT        NOT NULL,
  `expires_at`    DATETIME(6) NOT NULL,
  `created_at`    DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`    DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`sid`)
);
```

期限切れレコードはログイン時に掃除する（単一ユーザー運用のため cron は持たない）。

Kysely の型はスキーマから手書き（`apps/admin-backend/src/db/types.ts`）。件数・変更頻度的に codegen は入れない。

## 画像アップロードフロー

1. 管理画面（モバイル想定）で写真選択
2. クライアントで圧縮: `createImageBitmap` + canvas で長辺 1440px / WebP q0.8 目安（正方形トリミングは閲覧側 `object-cover` に任せ、原比率のまま保存）
3. `POST /api/images/presign` → `{ url, imageKey: 'images/logs/<ulid>.webp' }`
4. S3 へ直接 PUT（バケット CORS で admin オリジンの PUT を許可、presign 時に contentLength 上限チェック）
5. `POST /api/logs` に `imageKey` を渡して確定
6. 配信は CloudFront `/images/*` → S3（OAC）。`Cache-Control: public, max-age=31536000, immutable`（key が ULID なので immutable でよい）

## インフラ詳細（CDK）

- **VirginiaCertificateStack**（us-east-1, 新設）: `admin.<fqdn>` の ACM 証明書 + SSM。CloudFront から参照（cross-region は SSM 経由 + `AwsCustomResource` 読み出しか `crossRegionReferences: true`）
- **AdminStack**（ap-northeast-1, stage 単位 `{d,p}-st-admin`）
  - Cognito User Pool: self sign-up 無効・管理者 1 ユーザー手動作成・app client は public（secret なし）+ `ALLOW_USER_SRP_AUTH` + `ALLOW_REFRESH_TOKEN_AUTH`。MFA (TOTP) は任意で後付け
  - admin-api Lambda: `NodejsFunction`（esbuild, Node 22, ARM64）。VPC 配置は blog-api-construct と同じ SSM import（`/tidb-proxy/vpc/*`, `/tidb-proxy/proxy/sg-id`）+ Lambda SG（egress 13306/3128）。env: `DATABASE_URL=mysql://root@tidb-proxy.internal:13306/blog_{stage}`、Cognito の pool/client ID、Cookie 暗号鍵のシークレット ID（Secrets Manager で 48 文字を自動生成し Lambda に `grantRead`）
  - API Gateway HTTP API（apigwv2）+ `HttpLambdaIntegration`（`{proxy+}` に ANY）。CloudFront `/api/*` behavior のオリジンに設定（キャッシュ無効 + `AllViewerExceptHostHeader`）
  - S3 ×2: SPA バケット（`BucketDeployment` で `apps/admin-web/dist` を投入）/ images バケット（CORS: admin オリジンの PUT）
  - CloudFront: 上記 3 behavior + SPA fallback の CloudFront Function。`/api/*` はキャッシュ無効 + `AllViewerExceptHostHeader`
  - Route53: `admin.<fqdn>` A エイリアス → CloudFront
- GitHub Actions デプロイは既存 deploy-role（OIDC）に載せる

### 補足: Lambda Function URL + OAC 案の不採用

当初 `/api/*` は Lambda Function URL + OAC を検討したが、OAC がボディを署名しないため **POST / PUT にクライアント側で `x-amz-content-sha256` ヘッダ（ボディの SHA-256）を付ける必要がある**制約を嫌い不採用。API Gateway HTTP API を挟む（コスト微増だが制約なし）。認証はセッション Cookie（admin ドメインにのみ送信される）のため、API Gateway の execute-api URL を直叩きしても認証済みリクエストは成立しない。気になる場合は CloudFront からのカスタムヘッダ（`x-origin-verify`）検証を後付けできる。

## 認証フロー（SRP + セッション Cookie）

トークンをブラウザの storage に置く案（sessionStorage + Bearer）は **不採用**。HttpOnly Cookie のセッション方式にする。Cognito のトークン 3 本を Cookie に直接封入すると 4KB の Cookie 上限を超えうるため、**Cookie には暗号化したセッション ID（sid）のみを入れ、トークン実体は TiDB の `admin_sessions` に置く**。

1. `/login` ページの自前フォーム → `amazon-cognito-identity-js` の `CognitoUser.authenticateUser`（USER_SRP_AUTH。パスワードは平文送信されない）
2. 取得した access / id / refresh token を `POST /api/auth/login` へ渡す。backend が jose で検証 → セッションレコード（トークン一式 + 有効期限）を `admin_sessions` に保存し、`{ sid }` を seal（`iron-webcrypto`）した値を**暗号化 HttpOnly Cookie** で返す。ブラウザ側の storage にトークンは保持しない
3. 以降の API 呼び出しは Cookie の自動送信のみ。ミドルウェアが Cookie を unseal → `admin_sessions` からトークンを引き、access token を jose で検証。失効間近ならサーバ側で refresh token により更新しレコードを上書き。unseal 失敗・レコード無し・refresh 失敗は 401 → `/login` へ
4. FE ガード: TanStack Router の `beforeLoad` で `GET /api/me` を確認
5. ログアウト: `POST /api/auth/logout` → セッションレコード削除 + Cognito `RevokeToken` + Cookie 削除
6. CSRF: `SameSite=Lax` により cross-site の変更系リクエストには Cookie が送られない。保険として Origin allowlist + `X-Requested-With` 必須の簡易チェックを入れる

Cookie の属性（`hono/cookie` の `setCookie` / `getCookie` / `deleteCookie` でラップ）:

- 名前: 本番は `__Host-session`。ローカル dev（http）は `__Host-` プレフィックスが使えないため `session` に切り替え（`DEV_INSECURE_COOKIES=1` の env フラグで判定）
- `Secure`: 同フラグが立っていない限り常に true（`secure: !insecureCookies`）
- `HttpOnly: true` / `SameSite=Lax` / `Path=/`
- `maxAge` と seal の `ttl` は refresh token の TTL（30 日）に揃える
- 暗号鍵: Secrets Manager のシークレット（CDK で 48 文字を自動生成し Lambda に `grantRead`。シークレット ID を env で渡す）。取得値はプロセス内でメモ化し、32 文字未満なら起動時エラー

## 構築手順（チェックリスト）

**進捗はこのチェックリストに同期する。** 1 ステップ完了ごとに `- [x]` に更新して commit に含める。手順や設計が変わった場合はチェックリストと本文の両方を直す。

### フェーズ 0: DB スキーマ

- [ ] `tools/dsql-cli/dsl-tidb/schema/07_logs.sql` / `08_admin_sessions.sql` を追加（本ドキュメントの DDL）
- [ ] `load.sh` で `blog_dev` へ適用し、`SHOW CREATE TABLE blog_dev.logs` で確認
- [ ] `docs/.tbls.yaml` に `logs.user_id → users` の仮想リレーションを追加し、`docs/` で `bun run doc-gen`（`05_db/logs.md` 生成）

### フェーズ 1: apps/admin-backend（Hono API）

- [ ] 雛形作成（package.json / tsconfig / turbo タスク配線: `dev` `build` `type-check` `test`）
- [ ] 依存導入: `hono` `@hono/zod-openapi` `kysely` `mysql2` `jose` `iron-webcrypto`（Cookie の seal/unseal）`ulid` `@aws-sdk/client-s3` `@aws-sdk/s3-request-presigner` `@aws-sdk/client-cognito-identity-provider`（refresh / RevokeToken）`@aws-sdk/client-secrets-manager`（Cookie 暗号鍵）、dev: `@hono/node-server` `@scalar/hono-api-reference` `esbuild`
- [ ] `src/db/`: Kysely セットアップ（`DATABASE_URL`、mysql2 pool）+ `types.ts`（logs / admin_sessions テーブルの手書き型）
- [ ] `src/auth/`: セッション Cookie（seal した sid のみ。本番 `__Host-session`、dev は env フラグで非 Secure に切替）の発行・復号 + `admin_sessions` ストア + jose による access token 検証ミドルウェア（issuer / `token_use` / `client_id`、失効間近のサーバ側 refresh + レコード更新）
- [ ] `src/auth/`: Origin allowlist + `X-Requested-With` の簡易 CSRF チェック
- [ ] `src/schemas/`: zod スキーマ（`text` ≤ 180、fastener / fastenerColor の enum、cursor）
- [ ] `src/routes/`: `auth`（login / logout）/ `me` / `logs`（GET 一覧 cursor・POST・PATCH・DELETE）/ `images`（presign）
- [ ] `src/app.ts`: `basePath('/api')` + `defaultHook`（400 統一）+ `export type AppType`
- [ ] `src/index.ts`: `hono/aws-lambda` の `handle` + esbuild バンドル（`build.mjs` → `dist/index.mjs`）
- [ ] `src/dev.ts`: `@hono/node-server`（:3001）+ `/openapi.json` + Scalar `/doc`（dev 限定）
- [ ] unit テスト（バリデーション / cursor encode・decode）を `bun test` で
- [ ] ローカル疎通: `DATABASE_URL=mysql://root@tidb.<tailnet>:4000/blog_dev` で起動し、Scalar から CRUD 一巡

### フェーズ 2: apps/admin-web（管理画面 SPA）

- [ ] 雛形作成（Vite + React 19 + `@tanstack/router-plugin` + Tailwind CSS 4）、FSD ディレクトリ + steiger
- [ ] shadcn/ui 初期化（`shared/ui/`）
- [ ] `shared/api/`: `hc<AppType>`（workspace type import）+ fetch ラッパ（same-origin Cookie 送信 + `X-Requested-With` 付与、401 時 `/login` へ）
- [ ] `features/auth/`: SRP ログインフォーム（`amazon-cognito-identity-js`）→ `POST /api/auth/login` で Cookie セッション確立、auth guard（`beforeLoad` で `/api/me`）、ログアウト
- [ ] `entities/log/`: モデル + TanStack Query の API 呼び出し
- [ ] pages: `/login` / `/logs`（一覧 + 削除）/ `/logs/new`（TanStack Form + zod、180 字カウンタ、fastener / 色選択）
- [ ] 画像圧縮（`createImageBitmap` + canvas → WebP 長辺 1440px）→ presign → S3 PUT の一連フロー
- [ ] `vite.config.ts` の dev proxy（`/api` → `http://localhost:3001`）でローカル E2E（Cognito はフェーズ 3 の dev pool 構築後に接続）
- [ ] `bun run check`（lint / spell / type-check）グリーン

### フェーズ 3: iac/aws + デプロイ

- [ ] `lib/dns/virginia-certificate-stack.ts`（us-east-1、`admin.<fqdn>` 証明書 + SSM）
- [ ] `lib/config.ts` に `domain.admin` と SSM パス（virginia cert / cognito 出力）を追加
- [ ] `lib/admin/admin-stack.ts`: Cognito User Pool（self sign-up 無効）+ SRP 用 public client
- [ ] 同: admin-backend Lambda（`NodejsFunction`、VPC = tidb-proxy の SSM import、SG egress 13306/3128）+ Cookie 暗号鍵の Secrets Manager シークレット（自動生成 + `grantRead`）
- [ ] 同: API Gateway HTTP API + `HttpLambdaIntegration`（`{proxy+}` ANY）
- [ ] 同: S3 ×2（SPA / images + CORS）、CloudFront（3 behavior + SPA fallback CF Function + OAC）、Route53 A エイリアス
- [ ] `bin/cdk.ts` 配線 + cdk-nag suppressions + `test/admin.test.ts`
- [ ] dev デプロイ（admin.shuntaka.tech）→ `admin-create-user` で管理ユーザー作成
- [ ] CloudFront 経由で SRP ログイン → 画像付き投稿 → TiDB 反映まで通し確認
- [ ] GitHub Actions（既存 deploy-role / OIDC）に admin-web ビルド + デプロイを組み込み
- [ ] `blog_prd` へ DDL 適用 → prd デプロイ（admin.shuntaka.dev）で通し確認

### フェーズ 4: 公開側（shuntaka.dev の logs タブ）

- [ ] blog-api（Rust）: `GET /users/{name}/logs`（cursor、published のみ）+ テスト
- [ ] apps/web: `LogSummary` 型を `lib/api.ts` へ移設し `getLogs` 追加
- [ ] apps/web: `/logs` ルート追加 + `BaseLayout` の `currentTab` union に `'logs'` を追加
- [ ] `LogFeed` を実 API（cursor）に接続。画像 URL は admin ドメインの `/images/*`
- [ ] `DESIGN.md` に logs の意図的例外（揺れアニメーション / 留め具の実物描写）を明記
- [ ] tagpr リリース

## 未決事項

- 画像のサイズバリアント（一覧用サムネの縮小版を作るか。まずは 1 サイズで様子見）
- Cognito MFA (TOTP) を初期から入れるか
- `images.shuntaka.dev` への分離タイミング（公開画像を admin ドメインで配ることの是非）
- logs の draft 運用（status を最初から使うか、published のみで始めるか）
