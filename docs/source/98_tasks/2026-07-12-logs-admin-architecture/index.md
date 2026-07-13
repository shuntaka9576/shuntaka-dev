# moments 管理画面（admin.shuntaka.dev）のアーキテクチャ決定と実装計画

- 起票日: 2026-07-12
- 関連: [moments（旧称 logs）機能の構想と UI モック](../2026-07-12-logs-feature/index.md)
- ステータス: フェーズ 0〜3 実装・dev / prd デプロイ・通し確認まで完了（2026-07-13）。フェーズ 4（公開側 moments タブ）も実装済み（ブランチ `feat/moments-public`、**未コミット**）。残りは tagpr リリース。詳細は末尾の「経緯（実装ログ）」参照

## 決定事項

moments（旧称 logs）の投稿用管理画面。Cloudflare Workers + R2 案は **廃案**（Workers custom domain に DNS ゾーン移管が必要なため）、オール AWS の CloudFront 構成に決定。

| 論点            | 決定                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 名称            | **moments**（旧称 logs から一新）。logs はシステムログ（tidb-proxy のログ分析基盤の Glue テーブル名も `logs`）と誤読されやすく、moments は WeChat Moments 等の先例があり英語圏にも直感的に伝わる。タブ / ルート / API パス / DB テーブル / コンポーネント名まで moments 系で統一する                                                                                                    |
| ドメイン        | 管理画面 prd: `admin.shuntaka.dev` / dev: `admin.shuntaka.tech`、画像配信 prd: `images.shuntaka.dev` / dev: `images.shuntaka.tech`（いずれも `iac/aws/lib/config.ts` の fqdn に従い stage 単位。同一 CloudFront のエイリアス）                                                                                                                                                          |
| 配信            | CloudFront 1 ディストリビューション（エイリアス: admin + images の 2 ドメイン）。default → 管理画面 SPA（S3, OAC）/ `/api/*` → API Gateway HTTP API（→ VPC Lambda）/ `/images/*` → 画像 S3（OAC）。default と `/api/*` は CF Function の Host チェックで admin 以外を 403（images ホストに管理画面・API を露出させない）                                                                |
| 管理画面 FE     | React 19 + Vite + TanStack Router（file-based）/ Query / Form + zod + Tailwind CSS 4 + shadcn/ui + FSD 構成                                                                                                                                                                                                                                                                             |
| API             | Hono（`@hono/zod-openapi` の `OpenAPIHono`）+ Hono RPC（`hc<AppType>` を workspace 型共有）+ `hono/aws-lambda`。Node.js 24 / ARM64 / esbuild バンドルの VPC Lambda                                                                                                                                                                                                                      |
| TiDB 接続       | 既存 tidb-proxy VPC の private subnet に Lambda を配置し、`tidb-proxy.internal:13306` 経由で `blog_dev` / `blog_prd` に接続。外部 HTTPS は squid（3128）forward proxy 経由（blog-api と同じ SG パターン）                                                                                                                                                                               |
| ORM             | **Kysely**（MySQL dialect + mysql2）。DDL は既存の `tools/dsql-cli/dsl-tidb/schema/`（`${SCHEMA}` 注入 + `load.sh`）流儀で管理し、Kysely はクエリビルダとして利用                                                                                                                                                                                                                       |
| 認証            | Cognito User Pool + **USER_SRP_AUTH**（`amazon-cognito-identity-js`、SPA 内の自前ログインフォーム。Hosted UI は使わない）。トークンはブラウザに持たせず `POST /api/auth/login` で検証（`jose`）→ セッション実体は TiDB `admin_sessions` に保存し、**暗号化 HttpOnly Cookie**（本番 `__Host-session`, `Secure`, `SameSite=Lax`）にはセッション ID のみ格納。refresh はサーバ側で透過実行 |
| OpenAPI         | `@hono/zod-openapi` の `createRoute` でスキーマ定義。`/openapi.json` + Scalar（`@scalar/hono-api-reference`）の `/doc` は **ローカル開発サーバ限定**                                                                                                                                                                                                                                    |
| 画像            | クライアント側で圧縮（canvas → WebP。orig 長辺 1440px + 一覧用 thumb 長辺 640px の **2 サイズ**）→ `/api` で presigned PUT URL 発行 → S3 へ 2 本直接 PUT → 配信は `images.<fqdn>` の CloudFront `/images/*`（エッジキャッシュ）。DB には orig の `image_key` のみ保存（thumb は `_thumb` サフィックスで導出）し、URL は blog-api / admin が stage 設定から組み立てる                    |
| draft / preview | `status`（published / draft）を初期から運用し、公開 API は published のみ返す。プレビューは apps/web の `/moments/preview`（query パラメータ駆動で `MomentCard` を 1 枚レンダリング、noindex）を admin から新規タブで開く。画像はアップロード済みの公開 URL、テキストは query で渡すため認証不要で本番同一の見た目を確認できる                                                          |
| MFA             | Cognito MFA (TOTP) は初期は入れない（必要になったら後付け）                                                                                                                                                                                                                                                                                                                             |

## 構成図

```
Browser (admin SPA)
  │ ① ログイン: Cognito USER_SRP_AUTH（public client）→ トークンを POST /api/auth/login へ
  │ ② API: 暗号化 HttpOnly セッション Cookie（__Host-session, SameSite=Lax）を自動送信
  │ ③ 画像: presigned PUT で S3 直アップロード（クライアントで WebP 圧縮、orig / thumb の 2 サイズを 2 本 PUT）
  ▼
CloudFront ×1（エイリアス: admin.<fqdn> / images.<fqdn>、ACM us-east-1 は SAN で両ドメイン対応）
  ├─ default    → S3: admin SPA（OAC）
  ├─ /api/*     → API Gateway HTTP API → Lambda
  │                 └ Hono + Kysely（VPC: tidb-proxy private subnet）
  │                     ├ tidb-proxy.internal:13306 →（Tailnet）→ TiDB blog_{stage}
  │                     └ squid :3128（外部 HTTPS が必要になった場合の forward proxy）
  └─ /images/*  → S3: images バケット（OAC, 長め TTL）
                     ▲ presigned PUT（クライアント直アップロード, CORS で admin オリジン許可）

viewer-request の CloudFront Function（default と /api/* にアタッチ）:
  Host が admin.<fqdn> 以外 → 403 / `/api/` 以下は素通し / それ以外は SPA fallback
```

画像の公開配信は `images.<fqdn>`（prd: `images.shuntaka.dev` / dev: `images.shuntaka.tech`）で行う。admin と同一 CloudFront のエイリアスだが、Host チェックにより images ホストで応答するのは `/images/*` のみ。

公開側（shuntaka.dev の moments タブ）は従来どおり blog-api（Rust, api.shuntaka.dev）から読む。blog-api は DB の `image_key` と env `IMAGES_BASE_URL`（CDK が stage ごとに注入。prd: `https://images.shuntaka.dev` / dev: `https://images.shuntaka.tech`）から画像 URL を組み立てて返す。apps/web は `next/image` で表示するため `next.config.ts` の `images.remotePatterns` に images ドメインを追加する（optimizer がサーバサイドで fetch するので CORS は不要。CORS が必要なのはアップロードの PUT のみ）。admin SPA の一覧プレビューも同じ images URL を参照する。

## リポジトリ構成（追加分）

```
apps/
├── admin-web/      # 管理画面 SPA (Vite + React 19, FSD)
│   └── src/{app,pages,widgets,features,entities,shared}/
├── admin-api/  # Hono + Kysely (esbuild → Lambda, dev は @hono/node-server)
│   └── src/{routes,db,auth,schemas}/ + dev.ts（Scalar /doc はここだけ）
iac/aws/lib/
├── dns/virginia-certificate-stack.ts   # us-east-1 ACM（CloudFront 用。新設）
└── admin/admin-stack.ts                # Cognito + Lambda + S3×2 + CloudFront + Route53
```

- パッケージ管理は本リポジトリの流儀（Bun workspaces + Turbo、Vite+ (oxlint/oxfmt)、cspell）に合わせる
- `apps/admin-web` は `apps/admin-api` を `workspace:*` で type-only import し、`hc<AppType>` で end-to-end 型共有
- Vite dev proxy: `/api` → `http://localhost:${ADMIN_API_PORT}`（本番は CloudFront が同じパス構造を再現）
- `.config/wt.toml` に `ADMIN_API_PORT` / `ADMIN_WEB_PORT`（worktree ごとの hash_port）と post-remove の kill hook を追加済み。root の `bun run dev`（turbo dev）で admin-api も起動する

## API 設計（初期エンドポイント）

Hono は `basePath('/api')` で組む（CloudFront 側で prefix strip をしない。CF Function を減らすため）。

| Method / Path              | 内容                                                                                                                                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/login`     | SRP で得たトークンを検証してセッションを保存し、暗号化 HttpOnly Cookie を発行（認証不要の唯一のルート）                                                                                             |
| `POST /api/auth/logout`    | セッション削除 + Cognito `RevokeToken` + Cookie 破棄                                                                                                                                                |
| `GET /api/me`              | セッション検証の疎通確認（FE の auth guard 用）                                                                                                                                                     |
| `GET /api/moments`         | 一覧（draft 含む全 status、`moment_id` 降順）。cursor は `moment_id` 単独: ULID が時系列ソート可能なため並びが安定し、DATETIME(6) のマイクロ秒と JS Date のミリ秒の精度差による境界バグも避けられる |
| `POST /api/moments`        | 作成。`{ text(≤180), imageKey, fastener('clip'\|'tape'), fastenerColor?, status('published'\|'draft'), publishedAt? }`                                                                              |
| `PATCH /api/moments/:id`   | 更新（draft → published の公開操作を含む。公開時に `published_at` 未指定なら現在時刻を設定）                                                                                                        |
| `DELETE /api/moments/:id`  | 削除                                                                                                                                                                                                |
| `POST /api/images/presign` | presigned PUT URL を orig / thumb の 2 本発行。`{ contentType: 'image/webp', origLength, thumbLength }` → `{ imageKey, origUrl, thumbUrl }`                                                         |

- バリデーションエラーは `OpenAPIHono` の `defaultHook` で 400 に統一
- 認証ミドルウェア: セッション Cookie を unseal（sid）→ `admin_sessions` からトークンを取得し、access token を `jose` で検証（issuer / `token_use === 'access'` / `client_id`）。失効間近ならサーバ側で refresh してレコードを更新。加えて Origin allowlist + `X-Requested-With` の簡易 CSRF チェック

### 環境変数（admin-api）

| env                                               | 用途                                                                                                                                                                              |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                    | TiDB 接続文字列（本番: `mysql://root@tidb-proxy.internal:13306/blog_{stage}`）                                                                                                    |
| `DEV_AUTH_BYPASS_USER`                            | `DEV_AUTH_BYPASS=1` 時に成り代わる `users.name`（既定 shuntaka。ローカル専用）                                                                                                    |
| `COGNITO_USER_POOL_ID` / `COGNITO_CLIENT_ID`      | access token 検証（issuer / client_id）と refresh / RevokeToken                                                                                                                   |
| `COOKIE_SECRET`                                   | Cookie 暗号鍵。本番は CDK が deploy 時に Secrets Manager から取り出して注入（VPC 内 Lambda から Secrets Manager へ届かないため）。`COOKIE_SECRET_ID` 経由の実行時取得も実装は残置 |
| `HTTPS_PROXY` / `NO_PROXY` / `NODE_USE_ENV_PROXY` | 本番 Lambda の外部 HTTPS（Cognito API / JWKS）を squid 経由にする。AWS SDK は明示ハンドラ、fetch は `NODE_USE_ENV_PROXY=1`（Node 22.15+）で proxy 対応                            |
| `IMAGES_BUCKET_NAME`                              | presign 対象の images バケット                                                                                                                                                    |
| `IMAGES_BASE_URL`                                 | 配信 URL の組み立て（例: `https://images.shuntaka.tech`）                                                                                                                         |
| `ORIGIN_ALLOWLIST`                                | CSRF チェックの Origin 許可リスト（カンマ区切り）                                                                                                                                 |
| `DEV_INSECURE_COOKIES`                            | `1` で Cookie 名を `session`・`Secure` なしに切替（ローカル http 用）                                                                                                             |
| `DEV_AUTH_BYPASS`                                 | `1` で認証・CSRF を素通し（Cognito 未構築のローカル疎通用。本番では設定しない）                                                                                                   |
| `ADMIN_API_PORT`                                  | dev サーバーのポート（`.config/wt.toml` が worktree ごとに hash_port で採番。既定 43001）                                                                                         |

ひな形は `apps/admin-api/.env.example`（`cp .env.example .env.local` で dev.ts が起動時に読む）。

### 環境変数（admin-web）

| env                                                    | 用途                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `VITE_COGNITO_USER_POOL_ID` / `VITE_COGNITO_CLIENT_ID` | SRP ログイン（`amazon-cognito-identity-js`）                                   |
| `VITE_IMAGES_BASE_URL`                                 | プレビューで開く画像公開 URL の組み立て                                        |
| `VITE_PREVIEW_BASE_URL`                                | apps/web の `/moments/preview` を開くベース URL（例: `https://shuntaka.tech`） |
| `ADMIN_WEB_PORT`                                       | Vite dev サーバーのポート（wt.toml が採番。既定 43002。shell env から参照）    |

ひな形は `apps/admin-web/.env.example`（Vite が `.env.local` を自動で読む。`ADMIN_WEB_PORT` のみ shell env）。

## DB スキーマ（`dsl-tidb/schema/` に追加）

```sql
CREATE TABLE IF NOT EXISTS `${SCHEMA}`.`moments` (
  `moment_id`      CHAR(26)     NOT NULL,               -- ULID (固定 26 文字)
  `user_id`        CHAR(36)     NOT NULL,               -- users.user_id (CHAR(36)) に合わせる
  `text`           VARCHAR(180) NOT NULL,
  `image_key`      VARCHAR(255) NOT NULL,               -- orig の key。thumb は _thumb サフィックスで導出
  `fastener`       ENUM('clip','tape') NOT NULL DEFAULT 'clip',
  `fastener_color` ENUM('pink','blue','yellow','green') NULL,
  `status`         ENUM('published','draft') NOT NULL DEFAULT 'published',
  `published_at`   DATETIME(6)  NULL,                   -- draft は NULL。公開時に設定
  `created_at`     DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`     DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`moment_id`),
  KEY `idx_moments_feed` (`user_id`, `status`, `published_at`, `moment_id`)
);
```

セッション実体（Cognito トークン一式）は Cookie ではなく DB に置く（Cookie 4KB 上限対策 + 失効管理のため）。

```sql
CREATE TABLE IF NOT EXISTS `${SCHEMA}`.`admin_sessions` (
  `sid`           VARCHAR(64) NOT NULL,
  `user_id`       CHAR(36)    NOT NULL,               -- ログイン時に users.name から解決した users.user_id
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

Kysely の型はスキーマから手書き（`apps/admin-api/src/db/types.ts`）。件数・変更頻度的に codegen は入れない。

## 画像アップロードフロー

1. 管理画面（モバイル想定）で写真選択
2. クライアントで圧縮: `createImageBitmap` + canvas で orig（長辺 1440px / WebP q0.8 目安）と一覧用 thumb（長辺 640px）の 2 サイズを生成（正方形トリミングは閲覧側 `object-cover` に任せ、原比率のまま保存）
3. `POST /api/images/presign` → `{ imageKey: 'images/moments/<ulid>.webp', origUrl, thumbUrl }`（thumb の key は `images/moments/<ulid>_thumb.webp` に固定導出）
4. S3 へ 2 本直接 PUT（バケット CORS で admin オリジンの PUT を許可、presign 時に contentLength 上限チェック。両方成功してから次へ）
5. `POST /api/moments` に `imageKey` と `status` を渡して確定
6. 配信は `https://images.<fqdn>/images/moments/<ulid>.webp`（CloudFront `/images/*` → S3, OAC）。`Cache-Control: public, max-age=31536000, immutable`（key が ULID なので immutable でよい）。一覧は thumb（`<ulid>_thumb.webp`）、原寸表示は orig を参照。shuntaka.dev / admin のどちらから表示しても `<img>` タグ読み込み（apps/web は next/image optimizer のサーバサイド fetch）なので CORS 不要

## インフラ詳細（CDK）

- **VirginiaCertificateStack**（us-east-1, 新設）: `admin.<fqdn>` + `images.<fqdn>` を SAN に持つ ACM 証明書 + SSM。CloudFront から参照（cross-region は SSM 経由 + `AwsCustomResource` 読み出しか `crossRegionReferences: true`）
- **AdminStack**（ap-northeast-1, stage 単位 `{d,p}-st-admin`）
  - Cognito User Pool: self sign-up 無効・管理者 1 ユーザー手動作成・app client は public（secret なし）+ `ALLOW_USER_SRP_AUTH` + `ALLOW_REFRESH_TOKEN_AUTH`。MFA (TOTP) は初期は入れない（必要になったら後付け）
  - admin-api Lambda: `NodejsFunction`（esbuild, Node 22, ARM64）。VPC 配置は blog-api-construct と同じ SSM import（`/tidb-proxy/vpc/*`, `/tidb-proxy/proxy/sg-id`）+ Lambda SG（egress 13306/3128）。env: `DATABASE_URL=mysql://root@tidb-proxy.internal:13306/blog_{stage}`、Cognito の pool/client ID、`COOKIE_SECRET`（Secrets Manager で 48 文字を自動生成し、VPC 内から実行時に届かないため deploy 時に `AwsCustomResource` で取り出して注入）、`IMAGES_BUCKET_NAME` / `IMAGES_BASE_URL` / `ORIGIN_ALLOWLIST`、squid 経由の `HTTPS_PROXY` / `NO_PROXY` / `NODE_USE_ENV_PROXY=1`（一覧は「環境変数（admin-api）」を参照）
  - API Gateway HTTP API（apigwv2）+ `HttpLambdaIntegration`（`{proxy+}` に ANY）。CloudFront `/api/*` behavior のオリジンに設定（キャッシュ無効 + `AllViewerExceptHostHeader`）
  - S3 ×2: SPA バケット（`BucketDeployment` で `apps/admin-web/dist` を投入）/ images バケット（CORS: admin オリジンの PUT）
  - CloudFront: エイリアス `admin.<fqdn>` / `images.<fqdn>` の 2 ドメイン + 上記 3 behavior。viewer-request の CloudFront Function（default と `/api/*` にアタッチ）で Host チェック（admin 以外 403。`/api/` 以下は素通し、それ以外は SPA fallback）。`/api/*` はキャッシュ無効 + `AllViewerExceptHostHeader`
  - Route53: `admin.<fqdn>` / `images.<fqdn>` の A エイリアス → 同一 CloudFront
- 既存 main stack の blog-api Lambda に env `IMAGES_BASE_URL=https://images.<fqdn>` を追加（フェーズ 4 で moments API が `image_key` から画像 URL を組み立てるため）
- GitHub Actions デプロイは既存 deploy-role（OIDC）に載せる

### 補足: Lambda Function URL + OAC 案の不採用

当初 `/api/*` は Lambda Function URL + OAC を検討したが、OAC がボディを署名しないため **POST / PUT にクライアント側で `x-amz-content-sha256` ヘッダ（ボディの SHA-256）を付ける必要がある**制約を嫌い不採用。API Gateway HTTP API を挟む（コスト微増だが制約なし）。認証はセッション Cookie（admin ドメインにのみ送信される）のため、API Gateway の execute-api URL を直叩きしても認証済みリクエストは成立しない。気になる場合は CloudFront からのカスタムヘッダ（`x-origin-verify`）検証を後付けできる。

## 認証フロー（SRP + セッション Cookie）

トークンをブラウザの storage に置く案（sessionStorage + Bearer）は **不採用**。HttpOnly Cookie のセッション方式にする。Cognito のトークン 3 本を Cookie に直接封入すると 4KB の Cookie 上限を超えうるため、**Cookie には暗号化したセッション ID（sid）のみを入れ、トークン実体は TiDB の `admin_sessions` に置く**。

1. `/login` ページの自前フォーム → `amazon-cognito-identity-js` の `CognitoUser.authenticateUser`（USER_SRP_AUTH。パスワードは平文送信されない）
2. 取得した access / id / refresh token を `POST /api/auth/login` へ渡す。backend が jose で検証し、access token の `username` claim を `users.name`（UNIQUE）へ突き合わせて `user_id` を解決（対応レコードが無い Cognito ユーザーは 401）→ セッションレコード（`user_id` + トークン一式 + 有効期限）を `admin_sessions` に保存し、`{ sid }` を seal（`iron-webcrypto`）した値を**暗号化 HttpOnly Cookie** で返す。ブラウザ側の storage にトークンは保持しない
3. 以降の API 呼び出しは Cookie の自動送信のみ。ミドルウェアが Cookie を unseal → `admin_sessions` からトークンを引き、access token を jose で検証。失効間近ならサーバ側で refresh token により更新しレコードを上書き。unseal 失敗・レコード無し・refresh 失敗は 401 → `/login` へ。コンテンツはセッションレコードの `user_id` でスコープする（moments の一覧・作成・更新・削除すべて）
4. FE ガード: `AuthGuard` コンポーネント（`GET /api/me` の session query。失敗時は `/login` へ置き換え遷移）。参照実装の流儀に合わせ `beforeLoad` ではなくコンポーネントラップ方式
5. ログアウト: `POST /api/auth/logout` → セッションレコード削除 + Cognito `RevokeToken` + Cookie 削除
6. CSRF: `SameSite=Lax` により cross-site の変更系リクエストには Cookie が送られない。保険として Origin allowlist + `X-Requested-With` 必須の簡易チェックを入れる

Cookie の属性（`hono/cookie` の `setCookie` / `getCookie` / `deleteCookie` でラップ）:

- 名前: 本番は `__Host-session`。ローカル dev（http）は `__Host-` プレフィックスが使えないため `session` に切り替え（`DEV_INSECURE_COOKIES=1` の env フラグで判定）
- `Secure`: 同フラグが立っていない限り常に true（`secure: !insecureCookies`）
- `HttpOnly: true` / `SameSite=Lax` / `Path=/`
- `maxAge` と seal の `ttl` は refresh token の TTL（30 日）に揃える
- 暗号鍵: Secrets Manager のシークレット（CDK で 48 文字を自動生成）。VPC 内 Lambda から実行時に Secrets Manager へ届かないため、deploy 時に `AwsCustomResource` で値を取り出し `COOKIE_SECRET` として注入する。値はプロセス内でメモ化し、32 文字未満なら起動時エラー

## 構築手順（チェックリスト）

**進捗はこのチェックリストに同期する。** 1 ステップ完了ごとに `- [x]` に更新して commit に含める。手順や設計が変わった場合はチェックリストと本文の両方を直す。実行したコマンドは省略せず全量を各フェーズの「実行したコマンド」に記録する。

### フェーズ 0: DB スキーマ

- [x] `tools/dsql-cli/dsl-tidb/schema/07_moments.sql` / `08_admin_sessions.sql` を追加（本ドキュメントの DDL）
- [x] 新規 2 ファイルを `blog_dev` へ適用し、`SHOW CREATE TABLE` で確認。既存 DB では `04_articles.sql` の ALTER TABLE が非冪等で `load.sh` 全実行が途中で失敗するため、新規ファイルのみを同じ流儀で個別適用した（ゼロから構築する場合は従来どおり `load.sh`）
- [x] `docs/.tbls.yaml` に `moments.user_id → users` の仮想リレーションを追加し、`docs/` で `bun run doc-gen`（`05_db/moments.md` / `05_db/admin_sessions.md` 生成）。生成物は prettier で整形してからコミットする（ルートの lint が `prettier --check '**/*.{json,yaml}'` で `schema.json` を検査するため必須。md の整形は必須ではないが既存スタイルに合わせる）

実行したコマンド（リポジトリルートから。Tailscale ログイン済みが前提）:

```bash
# 接続確認
TAILNET=$(tailscale status --json | jq -r '.MagicDNSSuffix')
mysql -h "tidb.$TAILNET" -P 4000 -u root --connect-timeout=5 -N -B \
  -e "SELECT VERSION(); SHOW TABLES FROM blog_dev;"

# DDL 適用（新規 2 ファイルのみ。${SCHEMA} 置換は load.sh と同じ流儀）
cd tools/dsql-cli/dsl-tidb
for f in schema/07_moments.sql schema/08_admin_sessions.sql; do
  sed 's|${SCHEMA}|blog_dev|g' "$f" | mysql -h "tidb.$TAILNET" -P 4000 -u root --default-character-set=utf8mb4
done
cd ../../..

# 適用結果の確認
mysql -h "tidb.$TAILNET" -P 4000 -u root \
  -e "SHOW CREATE TABLE blog_dev.moments\G SHOW CREATE TABLE blog_dev.admin_sessions\G"

# DB ドキュメント再生成（docs/.tbls.yaml へのリレーション追加後）
cd docs && bun run doc-gen && cd ..

# 生成物の整形（schema.json は lint 必須、md はスタイル合わせ）
bunx prettier --write "docs/source/01_開発ドキュメント/05_db/schema.json" \
  "docs/source/01_開発ドキュメント/05_db/"*.md

# チェック
bunx cspell --no-progress tools/dsql-cli/dsl-tidb/schema/07_moments.sql \
  tools/dsql-cli/dsl-tidb/schema/08_admin_sessions.sql \
  "docs/source/01_開発ドキュメント/05_db/moments.md" \
  "docs/source/01_開発ドキュメント/05_db/admin_sessions.md" \
  docs/.tbls.yaml
bunx prettier --check docs/.tbls.yaml "docs/source/01_開発ドキュメント/05_db/schema.json"
```

### フェーズ 1: apps/admin-api（Hono API）

- [x] 雛形作成（package.json / tsconfig / turbo タスク配線: `dev` `build` `type-check` `test`）
- [x] 依存導入: `hono` `@hono/zod-openapi` `zod` `kysely` `mysql2` `jose` `iron-webcrypto`（Cookie の seal/unseal）`ulid` `@aws-sdk/client-s3` `@aws-sdk/s3-request-presigner` `@aws-sdk/client-cognito-identity-provider`（refresh / RevokeToken）`@aws-sdk/client-secrets-manager`（Cookie 暗号鍵）、dev: `@hono/node-server` `@scalar/hono-api-reference` `esbuild`
- [x] `src/db/`: Kysely セットアップ（`DATABASE_URL`、mysql2 pool、`timezone: 'Z'`）+ `types.ts`（moments / admin_sessions テーブルの手書き型）
- [x] `src/auth/`: セッション Cookie（seal した sid のみ。本番 `__Host-session`、dev は env フラグで非 Secure に切替）の発行・復号 + `admin_sessions` ストア + jose による access token 検証ミドルウェア（issuer / `token_use` / `client_id`、失効間近のサーバ側 refresh + レコード更新）
- [x] `src/auth/`: Origin allowlist + `X-Requested-With` の簡易 CSRF チェック
- [x] `src/schemas/`: zod スキーマ（`text` ≤ 180、fastener / fastenerColor / status の enum、cursor、presign）
- [x] `src/routes/`: `auth`（login / logout）/ `me` / `moments`（GET 一覧 draft 込み cursor・POST・PATCH（公開操作含む）・DELETE）/ `images`（presign。orig / thumb の 2 本発行）
- [x] `src/app.ts`: `basePath('/api')` + `defaultHook`（400 統一）+ `export type AppType`。エラーは `HTTPException` → `onError` で JSON に統一
- [x] `src/index.ts`: `hono/aws-lambda` の `handle` + esbuild バンドル（`build.mjs` → `dist/index.mjs`、約 2.2MB）
- [x] `src/dev.ts`: `@hono/node-server`（`ADMIN_API_PORT`、既定 43001）+ `/api/openapi.json` + Scalar `/api/doc`（dev 限定。basePath 配下に生えるため実パスは `/api` 付き。素の `/` は `/api/doc` へリダイレクト）
- [x] unit テスト（バリデーション / cursor encode・decode）を `bun test` で
- [x] ローカル疎通: `blog_dev` 直結 + `DEV_AUTH_BYPASS=1`（Cognito はフェーズ 3 で構築のため）で起動し、Scalar 表示 + curl で draft 作成 → 公開 → 一覧 → presign → 削除 → 404 / 400 系まで一巡

実行したコマンド（リポジトリルートから）:

```bash
# 依存導入
cd apps/admin-api
bun add hono @hono/zod-openapi zod kysely mysql2 jose iron-webcrypto ulid \
  @aws-sdk/client-s3 @aws-sdk/s3-request-presigner \
  @aws-sdk/client-cognito-identity-provider @aws-sdk/client-secrets-manager
bun add -d @hono/node-server @scalar/hono-api-reference esbuild

# チェック
bun run type-check && bun test src/ && bun run build
cd ../..
bunx vp fmt apps/admin-api && bunx vp lint apps/admin-api --deny-warnings
bun run spell-check

# ローカル疎通。Tailscale ログイン済み + AWS 認証を通したシェルで実行する
# (presign の署名に AWS 資格情報を使う)
TAILNET=$(tailscale status --json | jq -r '.MagicDNSSuffix')

export DEV_AUTH_BYPASS=1
export DEV_INSECURE_COOKIES=1
export DATABASE_URL="mysql://root@tidb.$TAILNET:4000/blog_dev"
export DEV_AUTH_BYPASS_USER=shuntaka
export IMAGES_BASE_URL=https://images.shuntaka.tech
# バケットはフェーズ 3 で作成するため、この時点では presign URL の生成のみ確認
export IMAGES_BUCKET_NAME=dummy-images-bucket
export ADMIN_API_PORT=43001

# 起動はリポジトリルートから turbo 経由で行う（bun dev なら全 dev タスクごと起動する）
bunx turbo dev --filter=@shuntaka-dev/admin-api &

curl -s -o /dev/null -w '%{http_code}\n' http://localhost:43001/api/doc         # 200
MOMENT_ID=$(curl -s -X POST http://localhost:43001/api/moments -H 'content-type: application/json' \
  -d '{"text":"疎通テスト","imageKey":"images/moments/01JZX3F4G5H6J7K8M9N0P1Q2R3.webp","fastener":"tape","fastenerColor":"pink","status":"draft"}' \
  | jq -r '.momentId')
echo "$MOMENT_ID"
curl -s -X PATCH "http://localhost:43001/api/moments/$MOMENT_ID" \
  -H 'content-type: application/json' -d '{"status":"published"}'               # publishedAt が現在時刻に
curl -s 'http://localhost:43001/api/moments?limit=1'
curl -s -X POST http://localhost:43001/api/images/presign -H 'content-type: application/json' \
  -d '{"contentType":"image/webp","origLength":1000000,"thumbLength":100000}'   # orig / thumb の 2 URL
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE "http://localhost:43001/api/moments/$MOMENT_ID"  # 204
kill %1
```

### フェーズ 2: apps/admin-web（管理画面 SPA）

- [x] 雛形作成（Vite + React 19 + `@tanstack/router-plugin` + Tailwind CSS 4）、FSD ディレクトリ + steiger。
- [x] shadcn/ui（`base-nova` スタイル = Base UI 版）を `shared/ui/` に配置。components.json を設置し、コンポーネントは参照プロジェクトから必要分（button / button-link / input / textarea / label / badge / card / skeleton）を移植
- [x] `shared/api/`: `hc<AppType>`（workspace type import。admin-api 側に `exports: "./src/app.ts"` を追加）。fetch ラッパは作らず `hc` の init に集約（Cookie 同送 + `X-Requested-With` 常時付与）。401 対応は `AuthGuard` が担う
- [x] `features/auth/`: SRP ログインフォーム（`amazon-cognito-identity-js`。インメモリ storage を渡して localStorage にトークンを残さない）→ `POST /api/auth/login` で Cookie セッション確立、`AuthGuard`（`/api/me`。beforeLoad ではなくコンポーネントラップ方式）、ログアウト
- [x] `entities/moment/`: RPC レスポンスから型導出（`InferResponseType`）+ TanStack Query（一覧は `infiniteQueryOptions` の cursor ページング）
- [x] pages: `/login` / `/moments`（draft 含む一覧 + 公開 / 削除）/ `/moments/new`（TanStack Form + zod、180 字カウンタ、fastener トグル / テープ 4 色スウォッチ、draft / published 切替、プレビュー = apps/web の `/moments/preview` を新規タブで開く）
- [x] 画像圧縮（`createImageBitmap`（EXIF 回転を反映）+ canvas → WebP。orig 長辺 1440px + thumb 長辺 640px の 2 サイズ）→ presign → S3 PUT ×2。プレビューと投稿で同一ファイルのアップロードは 1 回に抑制
- [x] `vite.config.ts` の dev proxy（`/api` → `http://localhost:${ADMIN_API_PORT}`。prefix は剥がさない）+ dev ポート `ADMIN_WEB_PORT`（既定 43002）
- [ ] ローカル E2E（root の `bun dev` で admin-web + admin-api を起動。Cognito 実接続はフェーズ 3 の dev pool 構築後で、それまでは backend 側 `DEV_AUTH_BYPASS=1` で確認）
- [x] lint / spell / type-check / steiger グリーン（root の `bun run lint` 一式通過）

実行したコマンド（リポジトリルートから）:

```bash
# 依存導入
cd apps/admin-web
bun add react react-dom @tanstack/react-router @tanstack/react-query @tanstack/react-form \
  zod hono amazon-cognito-identity-js @base-ui/react class-variance-authority clsx \
  tailwind-merge tw-animate-css shadcn @fontsource-variable/geist
bun add -d vite @vitejs/plugin-react @tanstack/router-plugin @tailwindcss/vite tailwindcss \
  steiger @feature-sliced/steiger-plugin @types/react @types/react-dom

# routeTree.gen.ts の生成込みでビルド → 型 → FSD 検査
bunx vite build
bun run type-check
bunx steiger src
cd ../..

# 整形と全体チェック
bunx vp fmt apps/admin-web apps/admin-api
bun run lint
```

### フェーズ 3: iac/aws + デプロイ

- [x] `lib/dns/virginia-certificate-stack.ts`（us-east-1、`admin.<fqdn>` + `images.<fqdn>` の SAN 証明書 + SSM。hosted zone ID は `lib/cross-region-ssm.ts` の `AwsCustomResource` で東京の SSM から読む）
- [x] `lib/config.ts` に `domain.admin` / `domain.images` と SSM パス（virginia cert / cognito 出力）を追加
- [x] `lib/admin/admin-stack.ts`: Cognito User Pool（self sign-up 無効、強パスワードポリシー、prd は deletionProtection + RETAIN）+ SRP 用 public client
- [x] 同: admin-api Lambda（`NodejsFunction` esbuild/ESM、VPC = tidb-proxy の SSM import、SG egress 13306/3128）+ Cookie 暗号鍵の Secrets Manager シークレット（自動生成。値は deploy 時に取り出して `COOKIE_SECRET` 注入）。外部 HTTPS（Cognito / JWKS）は squid 経由（AWS SDK は proxy ハンドラ、fetch は `NODE_USE_ENV_PROXY=1`）
- [x] 同: API Gateway HTTP API + `HttpLambdaIntegration`（`{proxy+}` ANY）
- [x] 同: S3 ×2（SPA / images + CORS。images は prd RETAIN、dev はローカル PUT 用に `http://localhost:*` も許可）、CloudFront（エイリアス admin / images の 2 ドメイン + 3 behavior + Host チェック付き SPA fallback CF Function + OAC、PRICE_CLASS_200）、Route53 A エイリアス ×2。SPA 資材は `BucketDeployment`（`apps/admin-web/dist` 不在時はこの stack のデプロイだけをブロック）
- [x] `bin/cdk.ts` 配線（`{d,p}-st-virginia-cert` / `{d,p}-st-admin`）+ cdk-nag suppressions + `test/admin.test.ts`（NodejsFunction をモックした snapshot + nag 検証）。deploy-role に `cognito-idp:*` / `cloudfront:*` / `secretsmanager:*` を追加
- [x] dev デプロイ（admin.shuntaka.tech）→ `admin-create-user` で管理ユーザー作成
- [x] CloudFront 経由で SRP ログイン → 画像付き投稿 → TiDB 反映 → `images.shuntaka.tech` での画像配信（+ images ホストで default / `/api/*` が 403 になること）まで通し確認（2026-07-13。途中で踏んだ障害 2 件は「トラブルシュート」参照）
- [x] GitHub Actions（既存 deploy-role / OIDC）に admin-web ビルド + デプロイを組み込み（`reusable-deploy.yaml` の admin ステップ: virginia-cert → SSM から Cognito 出力を読んで admin-web ビルド → admin。初回は Cognito 出力が無いまま SPA が焼かれるため、スタック適用後にもう一度 admin をデプロイする）
- [ ] `blog_prd` へ DDL 適用 → prd デプロイ（admin.shuntaka.dev）で通し確認

#### デプロイ手順

AWS 認証を通したシェル（aws-vault 等）で実行する。CI（`reusable-deploy.yaml` の admin ステップ）も同じ順序。

cdk コマンドは `iac/aws` で実行する（リポジトリルートだと `--app is required` で失敗する）。`cdk deploy d-st-admin` は依存スタック（`d-st-global-dns` / `d-st-virginia-cert`）を自動で含めるため、手順 1 を省いて 3 だけ実行しても依存分が先に適用される（初回 dev 適用はこの形で実施。所要 約20分、大半は CloudFront distribution の作成待ち）。

##### 初回のみ: us-east-1 の CDK bootstrap

CloudFront 用証明書スタックが us-east-1 に立つため、リージョン未 bootstrap なら先に実行する。

```bash
cd iac/aws
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
bunx cdk bootstrap "aws://${ACCOUNT_ID}/us-east-1"
```

##### dev デプロイ

```bash
cd iac/aws

# 1. us-east-1 の証明書スタック（cross-region で東京の hosted zone ID を参照する）
bunx cdk deploy d-st-virginia-cert -c stageName=dev --require-approval never

# 2. admin-web をビルド（初回は Cognito 出力が無いので空のままでよい）
POOL_ID=$(aws ssm get-parameter --name /dev/shuntaka/admin/user-pool-id --query 'Parameter.Value' --output text 2>/dev/null || echo '')
CLIENT_ID=$(aws ssm get-parameter --name /dev/shuntaka/admin/user-pool-client-id --query 'Parameter.Value' --output text 2>/dev/null || echo '')
(
  cd ../../apps/admin-web
  VITE_COGNITO_USER_POOL_ID="$POOL_ID" \
    VITE_COGNITO_CLIENT_ID="$CLIENT_ID" \
    VITE_IMAGES_BASE_URL=https://images.shuntaka.tech \
    VITE_PREVIEW_BASE_URL=https://shuntaka.tech \
    bun run build
)

# 3. admin スタック（Cognito / Lambda / API GW / S3×2 / CloudFront / Route53 / SPA 投入）
bunx cdk deploy d-st-admin -c stageName=dev --require-approval never

# 4. 初回のみ: Cognito 出力が SSM に出たので、実 ID を焼き込んで SPA を再デプロイ
#    (手順 2 → 3 をもう一度実行する)
```

##### 管理ユーザー作成（初回のみ）

username は `users.name` と一致させる（ログイン時に `users.name` → `user_id` を解決するため）。
仮パスワードのままだと初回変更チャレンジが返りログインフォームは弾くので、`--permanent` で本パスワードを設定する。

```bash
POOL_ID=$(aws ssm get-parameter --name /dev/shuntaka/admin/user-pool-id --query 'Parameter.Value' --output text)
aws cognito-idp admin-create-user \
  --user-pool-id "$POOL_ID" \
  --username shuntaka \
  --message-action SUPPRESS

# パスワード（12 文字以上・大小英数記号）は対話入力で環境変数へ取り込む
# （コマンドラインに直書きするとシェル履歴に残るため。bash / zsh 共通）
printf 'Password: '
read -rs ADMIN_PASSWORD
echo
aws cognito-idp admin-set-user-password \
  --user-pool-id "$POOL_ID" \
  --username shuntaka \
  --password "$ADMIN_PASSWORD" \
  --permanent
unset ADMIN_PASSWORD
```

##### 通し確認

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://admin.shuntaka.tech/            # 200 (SPA)
curl -s -o /dev/null -w '%{http_code}\n' https://admin.shuntaka.tech/api/me      # 401 (未ログイン)
curl -s -o /dev/null -w '%{http_code}\n' https://images.shuntaka.tech/           # 403 (Host ガード)
```

ブラウザで https://admin.shuntaka.tech → SRP ログイン → 画像付き投稿 → 一覧表示 → `blog_dev.moments` への反映と `https://images.shuntaka.tech/images/moments/...` の配信を確認する。

##### prd デプロイ

```bash
# DDL を blog_prd へ適用（Tailscale ログイン済みシェル）→ 2026-07-13 適用済み
TAILNET=$(tailscale status --json | jq -r '.MagicDNSSuffix')
for f in tools/dsql-cli/dsl-tidb/schema/07_moments.sql tools/dsql-cli/dsl-tidb/schema/08_admin_sessions.sql; do
  sed 's|${SCHEMA}|blog_prd|g' "$f" | mysql -h "tidb.$TAILNET" -P 4000 -u root --default-character-set=utf8mb4
done

# デプロイは dev と同じ流れで stage / prefix / ドメインを差し替える
#   d-st-virginia-cert → p-st-virginia-cert / d-st-admin → p-st-admin
#   -c stageName=prd / SSM パスは /prd/... / VITE_* は images.shuntaka.dev, shuntaka.dev
# 管理ユーザー作成・通し確認も同様 (admin.shuntaka.dev)
```

GitHub Actions（手動実行）でやる場合。admin ステップ入りの workflow 定義が main に必要なので、**本 PR のマージ後**に実行する。

```bash
# main から prd へ admin スタックをデプロイ
gh workflow run Deploy --ref main -f stageName=prd -f stack=admin

# 完走まで監視
sleep 5
gh run watch "$(gh run list --workflow Deploy --branch main --limit 1 --json databaseId -q '.[0].databaseId')"
```

prd も初回は Cognito 出力が SSM に無い状態で SPA が焼かれるため、完走後にもう一度同じ dispatch を実行して実 ID を焼き込む（dev の手順 4. と同じ理屈）。その後 `/prd/shuntaka/admin/user-pool-id` を使って管理ユーザーを作成し、admin.shuntaka.dev で通し確認する。

##### CI から実行する場合

GitHub Actions の `Deploy` workflow を `workflow_dispatch` で `stack=admin` を選んで実行する（main push の `all` にも admin は含まれる）。初回だけ上記 4. の再デプロイが必要なのは同じ。

`workflow_dispatch` は `--ref` で指定したブランチ上の workflow 定義とコードで動くため、**main へのマージ不要**で作業ブランチからそのまま dev へデプロイできる。VITE\_\* は CI が組み立てる（Cognito 2 つは SSM、URL 2 つは Environment variable `SITE_FQDN`）ので手元でのビルドも不要。

```bash
# push 済みの現在のブランチから dev へ admin スタックをデプロイ
BRANCH=$(git branch --show-current)
gh workflow run Deploy --ref "$BRANCH" -f stageName=dev -f stack=admin

# 完走まで監視
sleep 5
gh run watch "$(gh run list --workflow Deploy --branch "$BRANCH" --limit 1 --json databaseId -q '.[0].databaseId')"
```

実績: 2026-07-13 に `chore/adjustment-document` から `stageName=dev` / `stack=admin` で実行し 54 秒で完走（他スタックはスキップされることを確認）。

##### web（Vercel）のデプロイ経路

公開 web は AWS ではなく Vercel 配信のため、Deploy workflow の対象外。

- **dev（shuntaka.tech）**: Vercel がドメインを **git ブランチ `preview`** に割り当てているため、main への push で `sync-preview.yaml` が `preview` ブランチを main の HEAD に追従させ（API で ref 更新。初回はブランチ自動作成）、Vercel が自動デプロイする
- **prd（shuntaka.dev）**: tagpr のタグリリース（`tagpr.yaml` の deploy-vercel ジョブ、`vercel deploy --prod`）でのみ更新。`vercel.json` で main の git デプロイは無効化してあり、main push が本番に直行しない
- 注意: shuntaka.tech は dev 確認用のためアクセス制限を有効にしている（閲覧は所有者のみ）
- 注意: `preview` ブランチはマシン管理のミラーのため**ブランチ保護は付けない**（force 更新が前提。全ブランチ対象の ruleset を作る場合は `preview` を除外する）

###### GitHub 側の登録手順

deploy workflow は `environment: <stageName>` で GitHub Environments（dev / prd）の secrets / variables を参照する。既存デプロイ（main スタック等）で Environments と以下は登録済みのため、**admin 用に新規で必要なのは Environment variable `SITE_FQDN` のみ**。

| 種別     | 名前                                                                                           | 状態                                 |
| -------- | ---------------------------------------------------------------------------------------------- | ------------------------------------ |
| secret   | `AWS_ACCOUNT_ID` / `GH_APP_ID` / `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY`                | 登録済み（main 用）                  |
| variable | `GH_APP_SECRET_PEM_KEY_NAME` / `GH_WEBHOOK_SECRET_KEY_NAME` / `CLOUDINARY_API_SECRET_KEY_NAME` | 登録済み（main 用）                  |
| variable | `SITE_FQDN`                                                                                    | **新規**。公開サイトの apex ドメイン |

`SITE_FQDN` は admin-web ビルドの `VITE_IMAGES_BASE_URL`（`https://images.<SITE_FQDN>`）と `VITE_PREVIEW_BASE_URL`（`https://<SITE_FQDN>`）の組み立てに使う。

- UI から: リポジトリの Settings → Environments → `dev`（/ `prd`）→ Environment variables → New variable
- CLI から:

```bash
# 登録
gh variable set SITE_FQDN --env dev --body shuntaka.tech
gh variable set SITE_FQDN --env prd --body shuntaka.dev

# 確認
gh variable list --env dev
gh variable list --env prd
```

Environments 自体が無い場合（新リポジトリ等）は先に作成する。

```bash
gh api -X PUT "repos/{owner}/{repo}/environments/dev"
gh api -X PUT "repos/{owner}/{repo}/environments/prd"
```

実行したコマンド（リポジトリルートから。デプロイ以外の実装時分）:

```bash
# admin_sessions に user_id 列を追加（セッションは揮発データで dev は空のため再作成）
TAILNET=$(tailscale status --json | jq -r '.MagicDNSSuffix')
mysql -h "tidb.$TAILNET" -P 4000 -u root -N -B -e "SELECT COUNT(*) FROM blog_dev.admin_sessions;"  # 0 を確認
mysql -h "tidb.$TAILNET" -P 4000 -u root -e "DROP TABLE blog_dev.admin_sessions;"
sed 's|${SCHEMA}|blog_dev|g' tools/dsql-cli/dsl-tidb/schema/08_admin_sessions.sql \
  | mysql -h "tidb.$TAILNET" -P 4000 -u root --default-character-set=utf8mb4
mysql -h "tidb.$TAILNET" -P 4000 -u root -e "SHOW CREATE TABLE blog_dev.admin_sessions\G"
cd docs && bun run doc-gen && cd ..
bunx prettier --write "docs/source/01_開発ドキュメント/05_db/schema.json" "docs/source/01_開発ドキュメント/05_db/"*.md

# admin-api の proxy 対応依存
cd apps/admin-api && bun add https-proxy-agent @smithy/node-http-handler && cd ../..

# iac/aws（NodejsFunction のローカルバンドル用 esbuild + テスト）
cd iac/aws
bun add -d esbuild
bun run type-check
bunx vitest run            # snapshot + cdk-nag 検証
bun run test:update        # deploy-role への action 追加による snapshot 更新
cd ../..

# 整形と全体チェック
bunx prettier --write .github/workflows/deploy.yaml .github/workflows/reusable-deploy.yaml
bunx vp fmt iac/aws apps/admin-api
bun run lint
```

### フェーズ 4: 公開側（shuntaka.dev の moments タブ）

- [x] apps/web: UI モックの `LogCard` / `LogFeed`（+ Story）を `MomentCard` / `MomentFeed` にリネーム（Story タイトル / CSS クラス `moment-*` / CSS 変数 / keyframes まで一新）
- [x] blog-api（Rust）: `GET /users/{name}/moments`（cursor、published のみ。`image_key` + env `IMAGES_BASE_URL` から `image_url` / `thumb_url` を組み立てて返す）+ 単体テスト。iac 側で blog-api Lambda に env を追加（`domain.images` から組み立て、snapshot 更新済み）。cursor は admin と同じ moment_id（ULID）単独・`moment_id DESC` 順で、値は素の momentId（base64 化しない）。limit は 1〜50（default 20）、`limit+1` 件取得方式
- [x] apps/web: `MomentSummary` 型を `lib/api.ts` へ移設し `getMoments` 追加（`thumbUrl` を含む）
- [x] apps/web: `/moments` ルート追加 + `BaseLayout` の `currentTab` union に `'moments'` を追加（タブ並びは posts / moments / about）
- [x] `MomentFeed` を実 API（cursor）に接続（server で 1 ページ目 → `MomentsInfiniteFeed`（client）が cursor で継ぎ足し。追加読み込み失敗時はフィードを打ち切り）。一覧画像は `thumb_url` を使用（`next.config.ts` の `images.remotePatterns` に `images.shuntaka.dev` / `images.shuntaka.tech` を追加）
- [x] apps/web: `/moments/preview` ルート（query パラメータ img / text / fastener / color / date から `MomentCard` を 1 枚レンダリング。img は https + images ドメイン + `/images/moments/` パスのみ許可、noindex）
- [x] `DESIGN.md` に moments の意図的例外（揺れアニメーション / 留め具の実物描写）を明記（3 セクション構成・タブ小文字表記も更新）
- [x] 追加要望（2026-07-13）: admin に**編集**と**下書きに戻す**を実装。admin-api に `GET /moments/:id`（編集フォームの初期値用）を追加し、admin-web は一覧の published 行に「下書きに戻す」（`PATCH status: draft`。published_at は backend が NULL に揃える）、全行に「編集」導線、`/moments/:id/edit` の編集ページ（`MomentForm` を編集モード拡張。画像差し替えは任意で、未選択なら既存 imageKey を維持。clip へ変更時は fastenerColor: null を明示送信）
- [ ] tagpr リリース

フェーズ 4 の動作確認（2026-07-13）: ローカルで blog-api を dev DB に向けて起動し、`GET /users/shuntaka/moments` が published のみ返すこと（draft は除外）、レスポンス形式（camelCase、orig/thumb URL、RFC3339）、不正 cursor / limit=0 が 400 になることを確認。`cargo clippy -D warnings` / `cargo test` / root `bun run lint`（10 タスク）/ `next build` すべてグリーン。

## 料金見積り

追加リソースの固定費は Secrets Manager（$0.40/月 × dev/prd の 2 シークレット）のみで、**合計 月 $1 未満**の見込み。

- CloudFront / CloudFront Function: 無料枠（転送 1TB + 1,000 万リクエスト/月、Function 200 万実行/月）内
- API Gateway HTTP API / Lambda (ARM64): 従量課金のみ。個人の管理操作 + ブログ閲覧規模では実質 $0
- S3 ×2: orig + thumb で 1 投稿 ~0.3MB のため 1,000 投稿でも ~0.3GB ≒ $0.01/月
- Cognito: 1 ユーザー（無料枠 10,000 MAU）で $0。ACM 証明書も無料
- Route53: 既存 hosted zone に A レコード追加のみ（AWS リソースへのエイリアスクエリは無料）
- VPC まわり: 既存 tidb-proxy（Fargate + squid）を流用するため増分なし。NAT Gateway は新設しない（Lambda からの AWS API 呼び出しも squid 経由）
- 固定費をゼロにしたければ Cookie 暗号鍵を Secrets Manager から SSM Parameter Store の SecureString（standard パラメータは無料）へ置き換え可能。初期は CDK の自動生成 + rotation 余地を優先して Secrets Manager を採用

## 未決事項

アーキテクチャ上の未決はなし。当初の論点はすべて決定済み（名称は moments へ一新 / 画像は orig + thumb の 2 サイズ / MFA は初期なし / 配信は `images.<fqdn>` を初期採用 / draft 運用あり + `/moments/preview` でプレビュー）。

実装時に決める細目:

- ~~投稿者 `user_id` の決め方~~ → **決定**: env 固定は廃止。ログイン時に access token の `username` claim を `users.name`（UNIQUE）へ突き合わせて `user_id` を解決し `admin_sessions.user_id` に保存、以降の API はセッションの `user_id` でコンテンツをスコープする。Cognito ユーザーは `users.name` と同じ username で `admin-create-user` する
- `DELETE /api/moments/:id` で S3 の orig / thumb も削除するか。presign 後に投稿確定せず離脱した孤児画像の扱い（実害がほぼないため初期は放置。気になれば S3 ライフサイクルで対応）
- SPA デプロイ時のキャッシュ戦略（`index.html` を no-cache にするか、`BucketDeployment` の distribution 連携で invalidation を打つか）
- `published_at` のタイムゾーン運用（UTC 保存 + 表示時 JST 変換。既存 articles の慣例に合わせる）

なお EXIF（GPS 位置情報含む）は canvas 再エンコードで自動的に除去されるため、モバイル写真の位置情報漏れは設計上ケアされている。

## 経緯（実装ログ）

新しいセッションで作業を再開するためのコンテキスト。作業ブランチは `chore/adjustment-document`（PR #613、ベース main）。

### コミット済み

- `8329527` フェーズ 0: moments / admin_sessions の DDL 追加と `blog_dev` 適用、tbls ドキュメント生成
- `43ebdd1` フェーズ 0 の実行コマンド全量を記録
- `f8e6338` フェーズ 1: apps/admin-api（Hono + Kysely）実装とローカル疎通

### 未コミット（作業ツリーに存在）

- **フェーズ 2 一式**: apps/admin-web（Vite + React 19 + TanStack Router + FSD + shadcn base-nova）。実装の流儀は `~/repos/github.com/shuntaka9576/test-pj/apps/frontend` を踏襲。lint / type / steiger グリーン
- **フェーズ 3 一式**: iac/aws（VirginiaCertificateStack / AdminStack / cross-region-ssm / deploy-role 追記 / nag suppressions / test/admin.test.ts）、CI ワークフローの admin ステップ、admin-api の proxy 対応（https-proxy-agent + @smithy/node-http-handler）
- **認証のユーザー解決の設計変更**（下記）に伴う admin-api 修正、`08_admin_sessions.sql` の `user_id` 列追加（blog_dev へは適用済み）、tbls 再生成分

### 実装中に確定した設計変更（本文へ反映済み）

- ワークスペース名を `apps/admin-backend` → **`apps/admin-api`** に統一（2026-07-13。Lambda 物理名 `{d,p}-st-admin-api` と揃えるため。本ドキュメント内の旧表記も一括置換済み）
- 一覧 cursor は `created_at + moment_id` → **`moment_id`（ULID）単独**へ変更
- `ADMIN_USER_ID` の固定 env は**廃止**。ログイン時に access token の `username` → `users.name` で `user_id` を解決し `admin_sessions.user_id` に保存、API はセッションの `user_id` でスコープ
- Cookie 暗号鍵は Secrets Manager 自動生成のまま、**deploy 時に値を取り出して `COOKIE_SECRET` 注入**（VPC 内 Lambda から実行時に Secrets Manager へ届かないため）
- 本番 Lambda の外部 HTTPS（Cognito API / JWKS）は squid 経由（SDK は proxy ハンドラ、fetch は `NODE_USE_ENV_PROXY=1`。squid は destination 制限なしのため設定変更不要）
- dev サーバーのポートは wt.toml の hash_port（`ADMIN_API_PORT` / `ADMIN_WEB_PORT`）+ フォールバック 43001 / 43002。起動は root の `bun dev`（turbo）前提

### ローカル開発のハマりどころ（既知）

- `turbo dev` は起動時のパッケージグラフで固定されるため、ワークスペース追加後は dev セッションの再起動が必要
- ワークスペース構成が異なるブランチ間（例: ディレクトリ改名の前後）を行き来したら `bun install` で node_modules のリンクを張り直す。張り直さないと lint / type-check が依存を解決できず error 型扱いのエラーが大量に出る
- root `.env.local` は Vercel CLI に上書きされ wt.toml のポート定義が消えることがある（TODO 管理中の未解決課題）
- amazon-cognito-identity-js は `global` 参照するため index.html に `window.global = window` のシムを入れてある
- 画像アップロードの S3 PUT は presign URL 発行までは確認済み。dev スタック適用でバケットは作成済みのため、残る検証は通し確認（次のアクション 5.）で行う

### トラブルシュート: dev ログインが失敗する（2026-07-13 解消）

ログイン失敗の裏に独立した障害が 2 つ重なっていた。

#### 1. `blog_dev.admin_sessions` テーブル欠落で 500

- 事象: admin.shuntaka.tech で SRP ログイン後の `POST /api/auth/login` が 500 `{"error":"internal_error"}`（画面上は未ログインの 401 に見える）
- 原因: `blog_dev.admin_sessions` が存在しなかった。user_id 列追加時の「DROP → 再作成」のうち再作成が実際には反映されておらず、ログイン時の `deleteExpiredSessions()` が `ER_NO_SUCH_TABLE` で落ちていた
- 調査: `aws logs tail /aws/lambda/d-st-admin-api --since 10m --format short` で `Table 'blog_dev.admin_sessions' doesn't exist` の ERROR を確認
- 解消: DDL を再適用

```bash
TAILNET=$(tailscale status --json | jq -r '.MagicDNSSuffix')
sed 's|${SCHEMA}|blog_dev|g' tools/dsql-cli/dsl-tidb/schema/08_admin_sessions.sql \
  | mysql -h "tidb.$TAILNET" -P 4000 -u root --default-character-set=utf8mb4
```

- 補足: `/api` を curl 等で直接叩いて検証する場合、変更系リクエストは `X-Requested-With` ヘッダーが必須で、`Origin` は allowlist 内か不送信であること（満たさないと CSRF ガードが 403 `{"error":"forbidden"}` を返す）

#### 2. SPA からのみログインが 401 `invalid token`（hc の init.headers が Content-Type を消す）

- 事象: curl / スクリプトからの `POST /api/auth/login` は 204 で成功するのに、SPA からは常に 401 `{"error":"invalid token"}`。Lambda にエラーログは一切出ない（401 は Lambda にとって正常応答で、catch も例外を握りつぶしていた）
- 原因: `apps/admin-web/src/shared/api/index.ts` が `hc()` に `init: { headers: {...} }` を渡していた。hono/client は `fetch(url, { body, method, headers, ...opt.init })` と **init を最後に spread** するため、`init.headers` が自動付与の `Content-Type: application/json` を丸ごと上書きして消す。Content-Type の無い body は zod-openapi のバリデータ対象外となり `c.req.valid('json')` が空 → `verifyAccessToken(undefined)` → jose の `ERR_JWS_INVALID`（Compact JWS must be a string or Uint8Array）→ 401
- 修正:
  - `x-requested-with` を `init.headers` から `hc()` の `headers` オプションへ移動（Content-Type 付与前にマージされる正しい位置）
  - `routes/auth.ts` の catch に `console.error` を追加。以降この系統の障害は Lambda ログの `login: access token verification failed ...` で一発診断できる

### 次のアクション

1. 未コミット分のコミット（フェーズ 2 + 3。ユーザー指示があってから）
2. ~~dev デプロイ~~ → **初回適用済み**（2026-07-13）。`iac/aws` から `bunx cdk deploy d-st-admin -c stageName=dev --require-approval never` の 1 コマンドで実施（依存の d-st-global-dns / d-st-virginia-cert も自動適用）。疎通確認済み: `https://admin.shuntaka.tech/` 200 / `/api/me` 401 / `https://images.shuntaka.tech/` 403
3. ~~初回のみの再デプロイ（デプロイ手順の 4.）~~ → **実施済み**（配信中の SPA JS に実 Pool ID / Client ID の焼き込みを確認）
4. ~~`admin-create-user`~~ → **実施済み**（UserStatus CONFIRMED。username は `users.name` と同じ `shuntaka`）
5. ~~通し確認~~ → **完了**（2026-07-13）。SRP ログイン → 画像付き下書き投稿 → `blog_dev.moments` 反映 → `images.shuntaka.tech` の thumb 配信 200 / images ホスト 403 まで確認。テスト投稿（下書き 1 件）は不要になったら管理画面から削除
6. ログイン障害の修正 2 ファイル（admin-web の hc headers / admin-api の catch ログ）のコミット。管理ユーザーのパスワードはトラブルシュート中にターミナルへ表示されたため `admin-set-user-password --permanent` で更新を推奨
7. ~~`blog_prd` へ DDL 適用 → prd デプロイ~~ → **完了**（2026-07-13。admin.shuntaka.dev で確認済み。初回は Cognito 焼き込みのため 2 回 dispatch した）
8. ~~フェーズ 4（公開側 moments タブ）~~ → **実装済み**（2026-07-13、ブランチ `feat/moments-public`。チェックリストはフェーズ 4 の節を参照）。残りはコミット → PR → main マージ（= dev への blog-api / web デプロイ）→ tagpr リリースで本番反映
