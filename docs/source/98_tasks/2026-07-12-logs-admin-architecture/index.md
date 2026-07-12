# moments 管理画面（admin.shuntaka.dev）のアーキテクチャ決定と実装計画

- 起票日: 2026-07-12
- 関連: [moments（旧称 logs）機能の構想と UI モック](../2026-07-12-logs-feature/index.md)
- ステータス: 計画（実装未着手）

## 決定事項

moments（旧称 logs）の投稿用管理画面。Cloudflare Workers + R2 案は **廃案**（Workers custom domain に DNS ゾーン移管が必要なため）、オール AWS の CloudFront 構成に決定。

| 論点            | 決定                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 名称            | **moments**（旧称 logs から一新）。logs はシステムログ（tidb-proxy のログ分析基盤の Glue テーブル名も `logs`）と誤読されやすく、moments は WeChat Moments 等の先例があり英語圏にも直感的に伝わる。タブ / ルート / API パス / DB テーブル / コンポーネント名まで moments 系で統一する                                                                                                    |
| ドメイン        | 管理画面 prd: `admin.shuntaka.dev` / dev: `admin.shuntaka.tech`、画像配信 prd: `images.shuntaka.dev` / dev: `images.shuntaka.tech`（いずれも `iac/aws/lib/config.ts` の fqdn に従い stage 単位。同一 CloudFront のエイリアス）                                                                                                                                                          |
| 配信            | CloudFront 1 ディストリビューション（エイリアス: admin + images の 2 ドメイン）。default → 管理画面 SPA（S3, OAC）/ `/api/*` → API Gateway HTTP API（→ VPC Lambda）/ `/images/*` → 画像 S3（OAC）。default と `/api/*` は CF Function の Host チェックで admin 以外を 403（images ホストに管理画面・API を露出させない）                                                                |
| 管理画面 FE     | React 19 + Vite + TanStack Router（file-based）/ Query / Form + zod + Tailwind CSS 4 + shadcn/ui + FSD 構成                                                                                                                                                                                                                                                                             |
| API             | Hono（`@hono/zod-openapi` の `OpenAPIHono`）+ Hono RPC（`hc<AppType>` を workspace 型共有）+ `hono/aws-lambda`。Node.js 22 / ARM64 / esbuild バンドルの VPC Lambda                                                                                                                                                                                                                      |
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
├── admin-backend/  # Hono + Kysely (esbuild → Lambda, dev は @hono/node-server)
│   └── src/{routes,db,auth,schemas}/ + dev.ts（Scalar /doc はここだけ）
iac/aws/lib/
├── dns/virginia-certificate-stack.ts   # us-east-1 ACM（CloudFront 用。新設）
└── admin/admin-stack.ts                # Cognito + Lambda + S3×2 + CloudFront + Route53
```

- パッケージ管理は本リポジトリの流儀（Bun workspaces + Turbo、Vite+ (oxlint/oxfmt)、cspell）に合わせる
- `apps/admin-web` は `apps/admin-backend` を `workspace:*` で type-only import し、`hc<AppType>` で end-to-end 型共有
- Vite dev proxy: `/api` → `http://localhost:${ADMIN_API_PORT}`（本番は CloudFront が同じパス構造を再現）
- `.config/wt.toml` に `ADMIN_API_PORT` / `ADMIN_WEB_PORT`（worktree ごとの hash_port）と post-remove の kill hook を追加済み。root の `bun run dev`（turbo dev）で admin-backend も起動する

## API 設計（初期エンドポイント）

Hono は `basePath('/api')` で組む（CloudFront 側で prefix strip をしない。CF Function を減らすため）。

| Method / Path              | 内容                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/login`     | SRP で得たトークンを検証してセッションを保存し、暗号化 HttpOnly Cookie を発行（認証不要の唯一のルート）                                     |
| `POST /api/auth/logout`    | セッション削除 + Cognito `RevokeToken` + Cookie 破棄                                                                                        |
| `GET /api/me`              | セッション検証の疎通確認（FE の auth guard 用）                                                                                             |
| `GET /api/moments`         | 一覧（draft 含む全 status、`moment_id` 降順）。cursor は `moment_id` 単独: ULID が時系列ソート可能なため並びが安定し、DATETIME(6) のマイクロ秒と JS Date のミリ秒の精度差による境界バグも避けられる                          |
| `POST /api/moments`        | 作成。`{ text(≤180), imageKey, fastener('clip'\|'tape'), fastenerColor?, status('published'\|'draft'), publishedAt? }`                      |
| `PATCH /api/moments/:id`   | 更新（draft → published の公開操作を含む。公開時に `published_at` 未指定なら現在時刻を設定）                                                |
| `DELETE /api/moments/:id`  | 削除                                                                                                                                        |
| `POST /api/images/presign` | presigned PUT URL を orig / thumb の 2 本発行。`{ contentType: 'image/webp', origLength, thumbLength }` → `{ imageKey, origUrl, thumbUrl }` |

- バリデーションエラーは `OpenAPIHono` の `defaultHook` で 400 に統一
- 認証ミドルウェア: セッション Cookie を unseal（sid）→ `admin_sessions` からトークンを取得し、access token を `jose` で検証（issuer / `token_use === 'access'` / `client_id`）。失効間近ならサーバ側で refresh してレコードを更新。加えて Origin allowlist + `X-Requested-With` の簡易 CSRF チェック

### 環境変数（admin-backend）

| env                                          | 用途                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                               | TiDB 接続文字列（本番: `mysql://root@tidb-proxy.internal:13306/blog_{stage}`）              |
| `ADMIN_USER_ID`                              | 投稿者の `users.user_id`（単一ユーザー運用のため固定値で渡す）                              |
| `COGNITO_USER_POOL_ID` / `COGNITO_CLIENT_ID` | access token 検証（issuer / client_id）と refresh / RevokeToken                             |
| `COOKIE_SECRET_ID`                           | Cookie 暗号鍵の Secrets Manager シークレット ID。ローカルは `COOKIE_SECRET` で直接渡せる    |
| `IMAGES_BUCKET_NAME`                         | presign 対象の images バケット                                                              |
| `IMAGES_BASE_URL`                            | 配信 URL の組み立て（例: `https://images.shuntaka.tech`）                                   |
| `ORIGIN_ALLOWLIST`                           | CSRF チェックの Origin 許可リスト（カンマ区切り）                                           |
| `DEV_INSECURE_COOKIES`                       | `1` で Cookie 名を `session`・`Secure` なしに切替（ローカル http 用）                       |
| `DEV_AUTH_BYPASS`                            | `1` で認証・CSRF を素通し（Cognito 未構築のローカル疎通用。本番では設定しない）             |
| `ADMIN_API_PORT`                             | dev サーバーのポート（`.config/wt.toml` が worktree ごとに hash_port で採番。既定 43001）   |

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
2. クライアントで圧縮: `createImageBitmap` + canvas で orig（長辺 1440px / WebP q0.8 目安）と一覧用 thumb（長辺 640px）の 2 サイズを生成（正方形トリミングは閲覧側 `object-cover` に任せ、原比率のまま保存）
3. `POST /api/images/presign` → `{ imageKey: 'images/moments/<ulid>.webp', origUrl, thumbUrl }`（thumb の key は `images/moments/<ulid>_thumb.webp` に固定導出）
4. S3 へ 2 本直接 PUT（バケット CORS で admin オリジンの PUT を許可、presign 時に contentLength 上限チェック。両方成功してから次へ）
5. `POST /api/moments` に `imageKey` と `status` を渡して確定
6. 配信は `https://images.<fqdn>/images/moments/<ulid>.webp`（CloudFront `/images/*` → S3, OAC）。`Cache-Control: public, max-age=31536000, immutable`（key が ULID なので immutable でよい）。一覧は thumb（`<ulid>_thumb.webp`）、原寸表示は orig を参照。shuntaka.dev / admin のどちらから表示しても `<img>` タグ読み込み（apps/web は next/image optimizer のサーバサイド fetch）なので CORS 不要

## インフラ詳細（CDK）

- **VirginiaCertificateStack**（us-east-1, 新設）: `admin.<fqdn>` + `images.<fqdn>` を SAN に持つ ACM 証明書 + SSM。CloudFront から参照（cross-region は SSM 経由 + `AwsCustomResource` 読み出しか `crossRegionReferences: true`）
- **AdminStack**（ap-northeast-1, stage 単位 `{d,p}-st-admin`）
  - Cognito User Pool: self sign-up 無効・管理者 1 ユーザー手動作成・app client は public（secret なし）+ `ALLOW_USER_SRP_AUTH` + `ALLOW_REFRESH_TOKEN_AUTH`。MFA (TOTP) は初期は入れない（必要になったら後付け）
  - admin-api Lambda: `NodejsFunction`（esbuild, Node 22, ARM64）。VPC 配置は blog-api-construct と同じ SSM import（`/tidb-proxy/vpc/*`, `/tidb-proxy/proxy/sg-id`）+ Lambda SG（egress 13306/3128）。env: `DATABASE_URL=mysql://root@tidb-proxy.internal:13306/blog_{stage}`、Cognito の pool/client ID、Cookie 暗号鍵のシークレット ID（Secrets Manager で 48 文字を自動生成し Lambda に `grantRead`）、`ADMIN_USER_ID` / `IMAGES_BUCKET_NAME` / `IMAGES_BASE_URL` / `ORIGIN_ALLOWLIST`（一覧は「環境変数（admin-backend）」を参照）
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

### フェーズ 1: apps/admin-backend（Hono API）

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
cd apps/admin-backend
bun add hono @hono/zod-openapi zod kysely mysql2 jose iron-webcrypto ulid \
  @aws-sdk/client-s3 @aws-sdk/s3-request-presigner \
  @aws-sdk/client-cognito-identity-provider @aws-sdk/client-secrets-manager
bun add -d @hono/node-server @scalar/hono-api-reference esbuild

# チェック
bun run type-check && bun test src/ && bun run build
cd ../..
bunx vp fmt apps/admin-backend && bunx vp lint apps/admin-backend --deny-warnings
bun run spell-check

# ローカル疎通。Tailscale ログイン済み + AWS 認証を通したシェルで実行する
# (presign の署名に AWS 資格情報を使う)
TAILNET=$(tailscale status --json | jq -r '.MagicDNSSuffix')

export DEV_AUTH_BYPASS=1
export DEV_INSECURE_COOKIES=1
export DATABASE_URL="mysql://root@tidb.$TAILNET:4000/blog_dev"
export ADMIN_USER_ID=$(mysql -h "tidb.$TAILNET" -P 4000 -u root -N -B \
  -e "SELECT user_id FROM blog_dev.users LIMIT 1;")
export IMAGES_BASE_URL=https://images.shuntaka.tech
# バケットはフェーズ 3 で作成するため、この時点では presign URL の生成のみ確認
export IMAGES_BUCKET_NAME=dummy-images-bucket
export ADMIN_API_PORT=43001

# 起動はリポジトリルートから turbo 経由で行う（bun dev なら全 dev タスクごと起動する）
bunx turbo dev --filter=@shuntaka-dev/admin-backend &

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

- [ ] 雛形作成（Vite + React 19 + `@tanstack/router-plugin` + Tailwind CSS 4）、FSD ディレクトリ + steiger
- [ ] shadcn/ui 初期化（`shared/ui/`）
- [ ] `shared/api/`: `hc<AppType>`（workspace type import）+ fetch ラッパ（same-origin Cookie 送信 + `X-Requested-With` 付与、401 時 `/login` へ）
- [ ] `features/auth/`: SRP ログインフォーム（`amazon-cognito-identity-js`）→ `POST /api/auth/login` で Cookie セッション確立、auth guard（`beforeLoad` で `/api/me`）、ログアウト
- [ ] `entities/moment/`: モデル + TanStack Query の API 呼び出し
- [ ] pages: `/login` / `/moments`（draft 含む一覧 + 公開 / 削除）/ `/moments/new`（TanStack Form + zod、180 字カウンタ、fastener / 色選択、draft / published 切替、プレビュー = apps/web の `/moments/preview` を新規タブで開く）
- [ ] 画像圧縮（`createImageBitmap` + canvas → WebP。orig 長辺 1440px + thumb 長辺 640px の 2 サイズ）→ presign → S3 PUT ×2 の一連フロー
- [ ] `vite.config.ts` の dev proxy（`/api` → `http://localhost:3001`）でローカル E2E（Cognito はフェーズ 3 の dev pool 構築後に接続）
- [ ] `bun run check`（lint / spell / type-check）グリーン

### フェーズ 3: iac/aws + デプロイ

- [ ] `lib/dns/virginia-certificate-stack.ts`（us-east-1、`admin.<fqdn>` + `images.<fqdn>` の SAN 証明書 + SSM）
- [ ] `lib/config.ts` に `domain.admin` / `domain.images` と SSM パス（virginia cert / cognito 出力）を追加
- [ ] `lib/admin/admin-stack.ts`: Cognito User Pool（self sign-up 無効）+ SRP 用 public client
- [ ] 同: admin-backend Lambda（`NodejsFunction`、VPC = tidb-proxy の SSM import、SG egress 13306/3128）+ Cookie 暗号鍵の Secrets Manager シークレット（自動生成 + `grantRead`）
- [ ] 同: API Gateway HTTP API + `HttpLambdaIntegration`（`{proxy+}` ANY）
- [ ] 同: S3 ×2（SPA / images + CORS）、CloudFront（エイリアス admin / images の 2 ドメイン + 3 behavior + Host チェック付き SPA fallback CF Function + OAC）、Route53 A エイリアス ×2
- [ ] `bin/cdk.ts` 配線 + cdk-nag suppressions + `test/admin.test.ts`
- [ ] dev デプロイ（admin.shuntaka.tech）→ `admin-create-user` で管理ユーザー作成
- [ ] CloudFront 経由で SRP ログイン → 画像付き投稿 → TiDB 反映 → `images.shuntaka.tech` での画像配信（+ images ホストで default / `/api/*` が 403 になること）まで通し確認
- [ ] GitHub Actions（既存 deploy-role / OIDC）に admin-web ビルド + デプロイを組み込み
- [ ] `blog_prd` へ DDL 適用 → prd デプロイ（admin.shuntaka.dev）で通し確認

### フェーズ 4: 公開側（shuntaka.dev の moments タブ）

- [ ] apps/web: UI モックの `LogCard` / `LogFeed`（+ Story）を `MomentCard` / `MomentFeed` にリネーム
- [ ] blog-api（Rust）: `GET /users/{name}/moments`（cursor、published のみ。`image_key` + env `IMAGES_BASE_URL` から `image_url` / `thumb_url` を組み立てて返す）+ テスト。iac 側で blog-api Lambda に env を追加
- [ ] apps/web: `MomentSummary` 型を `lib/api.ts` へ移設し `getMoments` 追加
- [ ] apps/web: `/moments` ルート追加 + `BaseLayout` の `currentTab` union に `'moments'` を追加
- [ ] `MomentFeed` を実 API（cursor）に接続。一覧画像は `thumb_url` を使用（`next.config.ts` の `images.remotePatterns` に `images.shuntaka.dev` / `images.shuntaka.tech` を追加）
- [ ] apps/web: `/moments/preview` ルート（query パラメータ img / text / fastener / color / date から `MomentCard` を 1 枚レンダリング。img は images ドメインのみ許可、noindex。admin のプレビューボタンから開く）
- [ ] `DESIGN.md` に moments の意図的例外（揺れアニメーション / 留め具の実物描写）を明記
- [ ] tagpr リリース

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

- 投稿者 `user_id` の決め方（Cognito ログインユーザーと `users` レコードの対応。単一ユーザー運用のため env で固定 user_id を渡す想定）
- `DELETE /api/moments/:id` で S3 の orig / thumb も削除するか。presign 後に投稿確定せず離脱した孤児画像の扱い（実害がほぼないため初期は放置。気になれば S3 ライフサイクルで対応）
- SPA デプロイ時のキャッシュ戦略（`index.html` を no-cache にするか、`BucketDeployment` の distribution 連携で invalidation を打つか）
- `published_at` のタイムゾーン運用（UTC 保存 + 表示時 JST 変換。既存 articles の慣例に合わせる）

なお EXIF（GPS 位置情報含む）は canvas 再エンコードで自動的に除去されるため、モバイル写真の位置情報漏れは設計上ケアされている。
