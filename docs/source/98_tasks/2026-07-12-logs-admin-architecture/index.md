# logs 管理画面（admin.shuntaka.dev）のアーキテクチャ決定と実装計画

- 起票日: 2026-07-12
- 関連: [logs 機能の構想と UI モック](../2026-07-12-logs-feature/index.md)
- ステータス: 計画（実装未着手）

## 決定事項

logs の投稿用管理画面。Cloudflare Workers + R2 案は **廃案**（Workers custom domain に DNS ゾーン移管が必要なため）、オール AWS の CloudFront 構成に決定。

| 論点        | 決定                                                                                                                                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ドメイン    | prd: `admin.shuntaka.dev` / dev: `admin.shuntaka.tech`（`iac/aws/lib/config.ts` の fqdn に従い stage 単位）                                                                                                      |
| 配信        | CloudFront 1 ディストリビューション。default → 管理画面 SPA（S3, OAC）/ `/api/*` → API Gateway HTTP API（→ VPC Lambda）/ `/images/*` → 画像 S3（OAC）                                                            |
| 管理画面 FE | React 19 + Vite + TanStack Router（file-based）/ Query / Form + zod + Tailwind CSS 4 + shadcn/ui + FSD 構成（`~/repos/github.com/shuntaka9576/test-pj` 準拠）                                                    |
| API         | Hono（`@hono/zod-openapi` の `OpenAPIHono`）+ Hono RPC（`hc<AppType>` を workspace 型共有）+ `hono/aws-lambda`。Node.js 22 / ARM64 / esbuild バンドルの VPC Lambda                                               |
| TiDB 接続   | 既存 tidb-proxy VPC の private subnet に Lambda を配置し、`tidb-proxy.internal:13306` 経由で `blog_dev` / `blog_prd` に接続。外部 HTTPS は squid（3128）forward proxy 経由（blog-api と同じ SG パターン）        |
| ORM         | **Kysely**（MySQL dialect + mysql2）。DDL は既存の `tools/dsql-cli/dsl-tidb/schema/`（`${SCHEMA}` 注入 + `load.sh`）流儀で管理し、Kysely はクエリビルダとして利用                                                |
| 認証        | Cognito User Pool + **USER_SRP_AUTH**（`amazon-cognito-identity-js`、SPA 内の自前ログインフォーム。Hosted UI は使わない）。API 側は `jose`（`createRemoteJWKSet` + `jwtVerify`）で access token 検証（mbt 準拠） |
| OpenAPI     | `@hono/zod-openapi` の `createRoute` でスキーマ定義。`/openapi.json` + Scalar（`@scalar/hono-api-reference`）の `/doc` は **ローカル開発サーバ限定**（mbt 準拠）                                                 |
| 画像        | クライアント側で圧縮（canvas → WebP）→ `/api` で presigned PUT URL 発行 → S3 へ直接 PUT → 配信は CloudFront `/images/*`（エッジキャッシュ）                                                                      |

参考リポジトリ:

- FE スタック / CloudFront 単一オリジン統合: `~/repos/github.com/shuntaka9576/test-pj`（FSD + steiger、`hc<AppType>`、CloudFront Function で SPA fallback）
- Hono 構成 / Swagger / JWT 検証: `~/repos/github.com/classmethod-internal/mbt-aidd-consulting-materials` の `apps/bff`（routes 分割、`defaultHook`、Scalar は dev.ts のみ、`jose` で JWKS 検証）

## 構成図

```
Browser (admin SPA)
  │ ① ログイン: Cognito USER_SRP_AUTH（public client, secret なし）
  │ ② API: Authorization: Bearer <access token>
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

- パッケージ管理は本リポジトリの流儀（Bun workspaces + Turbo、Vite+ (oxlint/oxfmt)、cspell）に合わせる。test-pj の pnpm / husky は持ち込まない
- `apps/admin-web` は `apps/admin-backend` を `workspace:*` で type-only import し、`hc<AppType>` で end-to-end 型共有
- Vite dev proxy: `/api` → `http://localhost:3001`（test-pj の `server.proxy` と同じ。本番は CloudFront が同じパス構造を再現）

## API 設計（初期エンドポイント）

Hono は `basePath('/api')` で組む（CloudFront 側で prefix strip をしない。CF Function を減らすため）。

| Method / Path              | 内容                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| `GET /api/me`              | トークン検証の疎通確認（FE の auth guard 用）                                                |
| `GET /api/logs`            | 一覧（cursor ページング: `published_at` + `log_id`）                                         |
| `POST /api/logs`           | 作成。`{ text(≤180), imageKey, fastener('clip'\|'tape'), fastenerColor?, publishedAt? }`     |
| `PATCH /api/logs/:id`      | 更新                                                                                         |
| `DELETE /api/logs/:id`     | 削除                                                                                         |
| `POST /api/images/presign` | presigned PUT URL 発行。`{ contentType: 'image/webp', contentLength }` → `{ url, imageKey }` |

- バリデーションエラーは `OpenAPIHono` の `defaultHook` で 400 に統一（mbt 準拠）
- 認証ミドルウェア: `Authorization: Bearer` の access token を `jose` で検証（issuer / `token_use === 'access'` / `client_id`）

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
  - admin-api Lambda: `NodejsFunction`（esbuild, Node 22, ARM64）。VPC 配置は blog-api-construct と同じ SSM import（`/tidb-proxy/vpc/*`, `/tidb-proxy/proxy/sg-id`）+ Lambda SG（egress 13306/3128）。env: `DATABASE_URL=mysql://root@tidb-proxy.internal:13306/blog_{stage}`、Cognito の pool/client ID
  - API Gateway HTTP API（apigwv2）+ `HttpLambdaIntegration`（`{proxy+}` に ANY。mbt と同じ形）。CloudFront `/api/*` behavior のオリジンに設定（キャッシュ無効 + `AllViewerExceptHostHeader`）
  - S3 ×2: SPA バケット（`BucketDeployment` で `apps/admin-web/dist` を投入）/ images バケット（CORS: admin オリジンの PUT）
  - CloudFront: 上記 3 behavior + SPA fallback の CloudFront Function（test-pj の `spa-fallback.js` 相当）。`/api/*` はキャッシュ無効 + `AllViewerExceptHostHeader`
  - Route53: `admin.<fqdn>` A エイリアス → CloudFront
- GitHub Actions デプロイは既存 deploy-role（OIDC）に載せる

### 補足: Lambda Function URL + OAC 案の不採用

当初 `/api/*` は Lambda Function URL + OAC を検討したが、OAC がボディを署名しないため **POST / PUT にクライアント側で `x-amz-content-sha256` ヘッダ（ボディの SHA-256）を付ける必要がある**制約を嫌い不採用。API Gateway HTTP API を挟む（コスト微増だが制約なし。mbt と同じ形）。API は全ルート Cognito JWT 必須のため、API Gateway エンドポイントを直叩きされても CloudFront 経由と認証境界は同じ。気になる場合は CloudFront からのカスタムヘッダ（`x-origin-verify`）検証を後付けできる。

## 認証フロー（SRP）

1. `/login` ページの自前フォーム → `amazon-cognito-identity-js` の `CognitoUser.authenticateUser`（USER_SRP_AUTH。パスワードは平文送信されない）
2. 取得した access / id / refresh token は **メモリ + sessionStorage** 保持（BFF セッション Cookie 方式の test-pj とは意図的に変える。ユーザー決定）
3. API 呼び出しは `Authorization: Bearer <access token>`。401 時は refresh token で `REFRESH_TOKEN_AUTH` → 再試行、失敗なら `/login` へ
4. FE ガード: TanStack Router の `beforeLoad` で `GET /api/me` を確認（test-pj の auth-guard 相当）

## 実装フェーズ

| フェーズ | 内容                                                                                                                                                                                  | 検証                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 0        | `logs` DDL 追加（dsl-tidb/schema + load.sh で blog_dev へ適用）、docs の tbls 再生成                                                                                                  | `mysql` で DESC、`bun run doc-gen`                   |
| 1        | `apps/admin-api`: Hono + Kysely + zod-openapi + jose。ローカルは Tailnet 直結の DATABASE_URL（blog-api の Makefile.toml と同じ流儀）で `@hono/node-server` 起動、Scalar `/doc` で確認 | `bun test` + Scalar から手動疎通                     |
| 2        | `apps/admin`: Vite + TanStack + shadcn の SPA。ログイン（SRP）→ logs 一覧/作成/削除、画像圧縮 + presigned PUT                                                                         | Vite dev proxy でローカル E2E（Cognito は dev pool） |
| 3        | `iac/aws`: VirginiaCertificateStack + AdminStack。dev（admin.shuntaka.tech）で通し確認 → prd                                                                                          | CloudFront 経由で SRP ログイン〜投稿まで             |
| 4        | 公開側: blog-api（Rust）に `GET /users/{name}/logs`（cursor）追加、`apps/web` に `/logs` ルート + BaseLayout タブ + LogFeed 接続                                                      | Storybook モック → 実 API 置き換え                   |

## 未決事項

- 画像のサイズバリアント（一覧用サムネの縮小版を作るか。まずは 1 サイズで様子見）
- Cognito MFA (TOTP) を初期から入れるか
- `images.shuntaka.dev` への分離タイミング（公開画像を admin ドメインで配ることの是非）
- logs の draft 運用（status を最初から使うか、published のみで始めるか）
