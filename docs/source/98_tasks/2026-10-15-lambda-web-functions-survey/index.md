# Lambda Web Functions + CloudFront OAC への移行検討（blog-api / apps/web / admin-api）

- 起票日: 2026-10-15
- 対象: blog-api（Rust / Axum）、apps/web（Next.js 16 / Vercel）、admin-api（Hono）、proxy VPC
- ステータス: dev に適用済み・prd は未切り替え（2026-10-23）。blog-api は案 C（Node.js から Rust バイナリを子プロセスで起動）、API は `https://<fqdn>/api/*` に統合して `api.<fqdn>` を撤去する。admin-api は対象外。残りの作業は[切り替え手順](#切り替え手順)の表のとおり
- PR: [#817](https://github.com/shuntaka9576/shuntaka-dev/pull/817)
- 関連タスク:
  - [blog-api: Lambda + tsnet を VPC + Fargate Proxy 構成に移行](../2026-06-29-blog-api-tidb-proxy/index.md)
  - [記事詳細 API の content_html 事前生成（オンザフライ Markdown 変換の廃止）](../2026-07-02-articles-content-html-pregeneration/index.md)
  - [リリースフロー刷新（preview 廃止 + tagpr CalVer + Vercel タグリリース）](../2026-07-11-release-flow-tagpr-calver/index.md)
  - [logs 管理画面（admin.shuntaka.dev）のアーキテクチャ決定と実装計画](../2026-07-12-logs-admin-architecture/index.md)
  - [GitHub webhook の非同期化（自己 Event invoke で 10 秒配信タイムアウトを回避）](../2026-07-13-webhook-async-self-invoke/index.md)
- 検証用 PoC: `~/repos/github.com/shuntaka9576/cf-lambda-web-functions`（このリポジトリ外。CloudFront OAC + Web Function の CDK。synth / ローカル起動まで確認、未デプロイ）

## 背景

2026-10 に AWS Lambda Web Functions が発表された。ポートで待ち受ける HTTP サーバーをそのまま Lambda で動かせる関数タイプで、LWA（Lambda Web Adapter）は不要と公式ドキュメントに書かれている（[runtimes](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-runtimes.html#web-functions-runtimes-frameworks)）。

CloudFront OAC と組み合わせたとき、Function URL + OAC にあった「POST / PUT でクライアントが body の SHA256 を `x-amz-content-sha256` に入れる」制約がない。admin-api はこの制約を避けるために API Gateway HTTP API を挟んでいる（[logs 管理画面のアーキテクチャ決定](../2026-07-12-logs-admin-architecture/index.md)「補足: Lambda Function URL + OAC 案の不採用」）。

これを機に、ブログのサーバーサイドを Web Functions + CloudFront OAC にし、フロントエンドも Vercel から CloudFront に移せないかを検討した。

## Web Functions の確認済みの仕様

すべて公式ドキュメントで確認した（2026-10-15 時点）。

| 項目                   | 内容                                                                                                                                                                                                                  | 出典                                                                                                                                                                                                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ランタイム             | `nodejs24.x`（arm64）のみ。Node.js 以外は Event Functions か MicroVMs を使うよう案内されている                                                                                                                        | [web-functions](https://docs.aws.amazon.com/lambda/latest/dg/web-functions.html)                                                                                                                                                                                              |
| コード                 | バージョニング有効な S3 バケットの .zip のみ（展開後 512 MB まで）。コンテナイメージは不可。バケットポリシーで `lambda.amazonaws.com` に読み取りを許可する                                                            | [code-s3](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-code-s3.html)                                                                                                                                                                                            |
| 実行環境               | メモリ 2 GB 固定。`maxConcurrencyPerEnvironment` は 1〜128（デフォルト 64）                                                                                                                                           | [runtimes](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-runtimes.html#web-functions-runtimes-memory) / [CFN ServiceConfig](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-lambda-webfunctionrevision-serviceconfig.html) |
| タイムアウト           | 3〜900 秒（デフォルト 30 秒）                                                                                                                                                                                         | [CFN ServiceConfig](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-lambda-webfunctionrevision-serviceconfig.html)                                                                                                                      |
| 入口                   | Lambda が HTTPS エンドポイントを提供（HTTP/1.1）。カスタムドメインと WAF は CloudFront を前段に置く。WebSocket は不可                                                                                                 | [networking](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-networking.html)                                                                                                                                                                                      |
| イベント               | HTTP のみ。イベント駆動の処理は Event Functions を使う                                                                                                                                                                | [web-functions](https://docs.aws.amazon.com/lambda/latest/dg/web-functions.html)                                                                                                                                                                                              |
| VPC                    | egress network connector で VPC へ出る。別 AZ のサブネット 2 つ以上が必要。connector 自体はインターネットへの出口を提供しない（NAT が必要）。`HomeRegion` の endpoint のみ                                            | [networking](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-networking.html#web-functions-networking-vpc)                                                                                                                                                         |
| CloudFront OAC         | signing behavior は `always-amz-auth` のみ。PUT / POST / PATCH は `UNSIGNED-PAYLOAD` で署名するため `x-amz-content-sha256` は不要。viewer の `Authorization` は上書きされず関数まで届く                               | [CloudFront: Lambda Web Function origin](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda-web.html#oac-signing-behavior-lambda-web)                                                                            |
| Lambda@Edge            | OAC 付きの Web Function オリジンのビヘイビアでは origin request / origin response トリガーを使えない（CloudFront Functions は使える）                                                                                 | [CloudFront: Lambda Web Function origin](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda-web.html#oac-prerequisites-lambda-web)                                                                               |
| 料金（us-east-1, Arm） | $0.30 / 100 万リクエスト、$0.0000276944 / vCPU 秒（CPU を使った時間のみ）、$0.0000036667 / GB 秒（実行環境が存在する間、使ったメモリの分。[料金の実績](#料金の実績2026-10-27-時点)を参照）。Lambda の無料枠は効かない | [pricing](https://aws.amazon.com/lambda/pricing/)                                                                                                                                                                                                                             |

### CDK の対応状況（aws-cdk-lib 2.273.0）

- L1 のみ（`CfnWebFunction` / `CfnWebFunctionRevision` / `CfnWebFunctionEndpoint` / `CfnNetworkConnector` / `CfnResourcePolicy`）。このリポジトリの 2.261.0 には含まれない
- CloudFront L2 の `SigningBehavior` に `always-amz-auth` がない。OAC は `CfnOriginAccessControl` で作り、`HttpOrigin` の `originAccessControlId` で渡す
- CloudFormation の `ServiceConfig` には `EgressNetworkConnectorArn` があるが、2.273.0 の L1 の型には無い。`revision.addPropertyOverride('ServiceConfig.EgressNetworkConnectorArn', ...)` で設定する想定（未検証）

## 現状の構成で関係する点

| 対象                      | 現状                                                                                                                                                                                                                                 | 出典                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| blog-api                  | Rust / Axum を `DockerImageFunction` + LWA（`response_stream`）で動かし、API Gateway REST（STREAM）で公開。GitHub webhook は自己 Event invoke（`AWS_LWA_PASS_THROUGH_PATH=/events`）で非同期化                                       | `iac/aws/lib/api/blog-api-construct.ts`                                                                           |
| blog-api の Markdown 変換 | `content_html` は webhook の取り込み時に生成して保存。GET は `content_html` が NULL のときだけオンザフライ変換                                                                                                                       | `tools/dsql-cli/dsl-tidb/schema/04_articles.sql`（2026-07-02）、`apps/blog-api/api/src/handler/users_articles.rs` |
| apps/web                  | Next.js 16 を Vercel で配信。`cacheComponents` / `cacheLife`、`next/image` の `remotePatterns`、`@vercel/analytics` / `@vercel/speed-insights` を使用                                                                                | `apps/web/next.config.ts`、`apps/web/package.json`                                                                |
| apps/web のデプロイ       | 本番（shuntaka.dev）は tagpr のタグリリースで `vercel deploy --prod`。main への push は shuntaka.me（Vercel Preview 環境）へ反映                                                                                                     | `.github/workflows/tagpr.yaml`、`.github/workflows/deploy-preview.yaml`                                           |
| admin-api                 | Hono（Node.js 24 / arm64）を `hono/aws-lambda` で動かす。CloudFront `/api/*` → API Gateway HTTP API → Lambda で、このオリジンに OAC は無い。EventBridge の 5 分ごとの todo 生成も同じ Lambda に Event invoke                         | `iac/aws/lib/admin/admin-stack.ts`、`apps/admin-api/src/index.ts`                                                 |
| proxy VPC                 | `ap-northeast-1a` の 1 AZ、`natGateways: 0`。Public サブネットに tidb-proxy（Fargate、`assignPublicIp: ENABLED`）、Private Isolated サブネットに blog-api / admin-api の VPC Lambda。外向き HTTPS は tidb-proxy の squid（3128）経由 | `iac/aws/lib/proxy/proxy-vpc-construct.ts`、`iac/aws/ecspresso/tidb-proxy/ecs-service-def.jsonnet`                |

## 目標構成（案）

```
shuntaka.dev（CloudFront）
├─ /_next/static/* など → S3（OAC、長めの TTL）
├─ /api/*              → blog-api の Web Function（OAC）── egress network connector ──▶ tidb-proxy
└─ default             → Next.js の Web Function（OAC）
```

## フロントエンド（apps/web）

Node.js なので現時点で載せられる。Next.js の standalone 出力に、`AWS_LAMBDA_HTTP_ENDPOINT` から `HOSTNAME` / `PORT` を設定する `index.js` を足す（[env vars](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-revisions-env-vars.html)）。

決めることは次のとおり。

- `cacheComponents` のキャッシュ: 標準では実行環境ごとのメモリに置かれる。`cacheLife` の revalidate が 30 秒なので、まずはこのままで許容できる想定。実行環境をまたいで揃える必要が出たら `cacheHandlers` で外部ストアに置く
- `next/image` の最適化: 関数内（sharp）で動かすと CPU を使い、同じ実行環境の他のリクエストも遅くなる。Cloudinary の loader に寄せるか、moments の事前生成済み WebP（orig / thumb）をそのまま使うかを決める
- Host ヘッダー: CloudFront から Host を転送すると endpoint が 404 を返すため、`AllViewerExceptHostHeader` を使う。アプリから見える Host は endpoint のドメインになるので、OGP などの絶対 URL は `metadataBase` などで明示する
- Vercel 依存の置き換え: `@vercel/analytics` / `@vercel/speed-insights` をやめる。shuntaka.me（dev）は dev ステージの CloudFront で置き換える

## サーバーサイド（blog-api）

Rust は Web Functions で動かないため、方式を決める必要がある。読み取り系は `content_html` が事前生成済みなので、comrak / syntect を移植しなくてよい。

| 案                                                         | 内容                                                                                                                                                                                                                                 | 課題                                                                                                                                                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 読み取り API だけ TypeScript で作り直す                 | `/articles`、`/articles/{slug}`、`/articles/search`、`/articles/tag-facets`、`/moments`、`/ping` を Hono で Web Functions に載せる。`/webhooks/github` と `/events`（Markdown 変換、GitHub App）は今の Rust の Event Function に残す | Rust と TypeScript の二重管理になる。`content_html` が NULL の記事が残っていないかを移行前に確認する。Cloudinary の署名付き OGP URL、PLaMo（tidb-proxy:18080）を使う検索、OTel の移植が必要 |
| B. Rust のまま待つ                                         | Web Functions が Node.js 以外に対応するのを待つ                                                                                                                                                                                      | 対応時期が分からない                                                                                                                                                                        |
| C. Node の `index.js` から Rust バイナリを子プロセスで起動 | `AWS_LAMBDA_HTTP_ENDPOINT` で Rust サーバーを待ち受けさせる                                                                                                                                                                          | ドキュメントに記載がなく、動くか未検証。サポート外の使い方になる                                                                                                                            |
| D. Web Functions を使わず Function URL + OAC にする        | Rust の Event Function のまま、読み取り（GET）だけ CloudFront → Function URL（AWS_IAM）+ OAC にする。webhook の POST は別経路（API Gateway など）に残す                                                                              | GET 以外は OAC の SHA256 制約を受ける。LWA の response streaming と Function URL + OAC の組み合わせは未検証                                                                                 |

webhook は HMAC で検証しているため、OAC で守る必要はない。どの案でも webhook の非同期処理（自己 Event invoke）は Event Function に残す。

案 C を採用した。Go のバイナリを Node.js から起動する方式は Lambda 上で動くことを確認済み（[Lambda Web Functions で Node.js の CPU バウンド処理は他のリクエストを待たせるか](https://dev.classmethod.jp/articles/shuntaka-lambda-web-functions-nodejs-cpu-bound/)）。blog-api も同じ作りにする。

## VPC 接続

Web Functions から tidb-proxy に繋ぐには egress network connector が必要で、別 AZ のサブネットが 2 つ以上いる。proxy VPC は 1 AZ なので、別 AZ に Private Isolated サブネットを 1 つ足す。

- `ec2.Vpc` の `availabilityZones` を変えるとサブネットの作り直しになる可能性が高いため、既存の VPC 定義は変えずにサブネット（ルートテーブル含む）を別リソースとして足す想定
- tidb-proxy は `ap-northeast-1a` のままでよい。connector の ENI が別 AZ にある場合は AZ 間通信になる
- 外向き HTTPS は今と同じく squid（3128）を経由させる（connector はインターネットへの出口を提供しないため）

## admin-api

admin-api は Node.js 24 の Hono なので、ランタイムの面ではそのまま Web Functions に載る。API Gateway HTTP API を挟んだ理由（SHA256 の制約）も Web Functions + OAC で解消し、execute-api への直接アクセスも OAC で塞げる。

課題は次のとおり。

- VPC 接続は blog-api と同じく、別 AZ のサブネットと network connector が必要
- EventBridge の todo 生成バッチが同じ Lambda に Event invoke しているため、バッチを Event Function として切り出す
- メモリが 512 MB から 2 GB 固定になる。アクセスの少ない管理画面では今より高くなる可能性がある

## 進め方（案）

1. PoC（`cf-lambda-web-functions`）をデプロイし、POST・`Authorization` の転送・SSE・endpoint への直接アクセスが 403 になることを確認する
2. apps/web を Web Functions + CloudFront に移す。API は既存の `api.shuntaka.dev` を使う
3. proxy VPC に別 AZ のサブネットと network connector を足し、blog_dev で接続を確認する
4. blog-api の方式（上の A〜D）を決めて移行する
5. 必要なら admin-api も移す

## 決定事項

| 項目             | 決定                                                                                                                                                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| blog-api の方式  | 案 C。`apps/blog-api/web-function/index.mjs` が `server`（aarch64 musl の静的バイナリ）を起動し、Rust が `AWS_LAMBDA_HTTP_ENDPOINT` に bind する。webhook の実処理は従来の Event Function（Docker + LWA）へ Event invoke する |
| API の置き場所   | `https://<fqdn>/api/*` に統合し、CloudFront Function で `/api` を外して blog-api に渡す。`api.<fqdn>`（API Gateway REST + カスタムドメイン）は撤去                                                                            |
| CORS             | 撤去。ブラウザは同一オリジンの `/api` を呼ぶ。ローカル開発は next dev の rewrites で `/api/*` を blog-api へ中継する                                                                                                          |
| `next/image`     | `unoptimized: true`。サムネイルは Cloudinary の署名付き URL（変換パラメータを足すと署名が壊れる）、moments は事前生成済みの WebP のため                                                                                       |
| 静的アセット     | S3 には置かず、Next.js の Web Function から返して `/_next/static/*` を CloudFront で長くキャッシュする（PoC と同じ）                                                                                                          |
| キャッシュの破棄 | 静的ページは `s-maxage=31536000` で返るため、apps/web の revision が変わったら CloudFront を `/*` で invalidation する（AwsCustomResource）                                                                                   |
| VPC 接続         | proxy VPC に `ap-northeast-1c` の Private Isolated サブネット（`10.50.3.0/24`。経緯は「dev の巻き戻り」を参照）を足し、blog-api の Web Function だけに egress network connector を付ける。SG は Event Function と共有         |
| CDK              | aws-cdk-lib 2.274.0。`ServiceConfig.egressNetworkConnectorArn` が型に入ったため override は不要                                                                                                                               |
| admin-api        | 対象外（API Gateway HTTP API のまま）                                                                                                                                                                                         |

## 実装

| 対象         | 変更                                                                                                                                                                                                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CDK          | `iac/aws/lib/web-function.ts`（Web Function 一式の L1 ラッパー）、`iac/aws/lib/web-function-package.ts`（zip の作成）、`iac/aws/lib/api/site-construct.ts`（CloudFront / apex の alias / invalidation）、`blog-api-construct.ts`（API Gateway 撤去、connector 追加） |
| blog-api     | `EVENT_FUNCTION_NAME` で invoke 先を受け取る（`LambdaEventInvoker`）。`AWS_LAMBDA_HTTP_ENDPOINT` があればそこに bind する。`CorsLayer` を削除                                                                                                                        |
| apps/web     | `output: 'standalone'`、`@vercel/analytics` / `@vercel/speed-insights` / `vercel.json` を削除。サーバー側の fetch は `API_URL`、ブラウザは `/api`                                                                                                                    |
| ワークフロー | `deploy-preview.yaml` と tagpr の `deploy-vercel` ジョブを削除。deploy ランナーに cargo-zigbuild / zig を導入し、ビルド用の Environment variable を渡す                                                                                                              |

ローカルで次を確認した。

- `cargo zigbuild --release --target aarch64-unknown-linux-musl --bin server` が通る（aws-lc-sys / ring / onig の C 依存を含めて静的リンク、33 MB）
- Lambda の `public.ecr.aws/lambda/nodejs:24`（Amazon Linux 2023、glibc 2.34）上で `index.mjs` から起動し、`/health` と `/health/db`（MySQL への SELECT 1）が 204 を返す
- `cdk synth`（実際の bundling 込み）で作った apps/web の zip（5.2 MB、展開後 21 MB）を Lambda の Node.js 24 イメージで `node index.mjs` 起動し、ページ・`/_next/static/*`・`public/` が返る
- bun の node_modules はシンボリックリンクで組まれているため、zip にはリンクのまま入れる（`zip -y`）。実体化すると Node.js の realpath による解決が崩れ、`@swc/helpers` が見つからずに起動できなかった
- standalone には macOS 用の sharp（`@img/sharp-darwin-arm64` など）が入るため、zip を作るときに外す。`outputFileTracingExcludes` では bun の `.bun/` 配下を外せなかった

dev（shuntaka.me）にデプロイして次を確認した。

- apex の A / AAAA が CloudFront の alias になり、レスポンスに `via: ... (CloudFront)` と `x-cache` が付く。`api.shuntaka.me` は消えた
- ページは `s-maxage=30, stale-while-revalidate=86370` を返し、Next.js の `x-nextjs-cache` が STALE → HIT と遷移する（ISR）。`/_next/static/*` は `immutable`
- `/api/health/db`（TiDB に SELECT 1）、記事一覧、検索（PLaMo）が返る。connector の ENI から `tidb-proxy.internal`（Cloud Map の private DNS）を引けている
- 不正な署名の webhook POST が 401 になる（POST が OAC を越えて Web Function に届き、HMAC で弾かれる）
- `Origin` 付きの API リクエストに `Access-Control-*` ヘッダーが付かない

## 切り替え手順

dev → prd の順に切り替え、最後に Vercel と旧構成の残りを片付ける。

| #   | 作業                                                                         | 状態                                                                    |
| --- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1   | dev に適用する（ブランチから deploy.yaml を dispatch）                       | 済（2026-10-23。run 39888301734、巻き戻りからの復旧は run 39901222336） |
| 2   | GitHub App（dev）の Webhook URL を変え、記事の push で反映されるか確かめる   | 済（2026-10-23）                                                        |
| 3   | PR #817 をマージする                                                         | 未                                                                      |
| 4   | prd の Environment variable を入れ、リリース PR をマージする                 | 未                                                                      |
| 5   | GitHub App（prd）の Webhook URL を変え、prd の `WEB_BUILD_API_URL` を消す    | 未                                                                      |
| 6   | 後片付け（Vercel、secret、tokyo-cert、`deleteExisting`、管理外のサブネット） | 管理外のサブネットは済（2026-10-23）。ほかは prd の切り替え後に行う     |

apex を CloudFront に向け直す初回だけ、next build の時点ではまだ `https://<fqdn>/api` が無い。そのため `WEB_BUILD_API_URL` で旧 API（`https://api.<fqdn>`）を指し、切り替え後に消す。

### 1. dev に適用する（済）

GitHub Environments の dev に変数を入れ、ブランチから deploy を dispatch した。

```bash
gh variable set WEB_BUILD_API_URL --env dev --body 'https://api.shuntaka.me'
gh workflow run deploy.yaml --ref survey/lambda-web-functions -f stageName=dev -f stack=all
```

デプロイの順は `st-tidb-proxy`（別 AZ のサブネット）→ `st-tidb-proxy-logs` → main（GlobalDns と virginia-cert を含む）→ admin。dev の apex は GlobalDnsStack が先に Vercel 向けの A レコードを消すため、main の完了まで shuntaka.me は落ちる。

ページ、API、DB、検索が CloudFront 経由で返ることを確かめてから変数を消した。

```bash
curl -sI https://shuntaka.me/ | grep -iE '^(via|x-cache)'
curl -s -o /dev/null -w '%{http_code}\n' https://shuntaka.me/api/health/db
curl -s 'https://shuntaka.me/api/users/shuntaka/articles?perPage=1' | head -c 200
gh variable delete WEB_BUILD_API_URL --env dev
```

### 2. GitHub App（dev）の Webhook URL を変える（済）

GitHub の Settings → Developer settings → GitHub Apps → dev 用の App → General で、Webhook URL を `https://shuntaka.me/api/webhooks/github` に変える。記事リポジトリ（または lab-contents-dev）に push し、App の Advanced → Recent Deliveries が 200（`accepted`）になることを確かめる。

Web Function が受けて Event Function へ Event invoke し、Event Function が実処理する流れはここで初めて通る。ログで両方を確かめる。

```bash
aws logs tail /aws/lambda-web/d-st-blog-api-web --since 15m
aws logs tail /aws/lambda/d-st-blog-api --since 15m
```

dev 用の App（articles-v2 にインストールしている App）の Webhook URL を変え、articles-v2 のテスト記事 `a2` に目印の行を足して main に push した。最初は別の App の URL を変えていて、配信が shuntaka.me に届かなかった。articles-v2 にインストールしている App を直してからは、次のとおり通った。

| 時刻（JST） | 場所                     | 結果                                                                                                                    |
| ----------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| 15:20:19    | articles-v2              | main に push                                                                                                            |
| 15:20:20    | blog-api の Web Function | `Received GitHub webhook: event_type=push` → `Queued push event for async processing`（Event Function へ Event invoke） |
| 15:20 台    | Event Function           | `Processing async push event: ref=refs/heads/main, repo=shuntaka9576/articles-v2, kind=articles`                        |
| 15:20:27    | dev の API               | `/api/users/shuntaka/articles/a2` に目印が出た（push から約 8 秒）                                                      |

Web Function 上の Rust の AWS SDK が認証情報を取り、squid（`HTTPS_PROXY`）経由で Lambda API を呼べることも、ここで確かめられた。

### 3. PR #817 をマージする

マージまでは、main への push のたびに旧構成で dev がデプロイされて巻き戻る（[dev の巻き戻り](#dev-の巻き戻り2026-10-23)）。マージまで main へのマージ（Renovate を含む）を止める。マージ後の main への push は、このブランチと同じコードを dev にデプロイするだけなので差分は出ない。

### 4. prd を切り替える

リリース PR をマージする前に、GitHub Environments の prd に変数を入れる。GTM / Clarity の ID は Vercel の Production 環境変数から移す。

```bash
gh variable set WEB_BUILD_API_URL --env prd --body 'https://api.shuntaka.dev'
gh variable set NEXT_PUBLIC_GOOGLE_TAG_MANAGER_ID --env prd --body 'GTM-XXXXXXX'
gh variable set NEXT_PUBLIC_CLARITY_PROJECT_ID --env prd --body 'xxxxxxxxxx'
```

リリース PR（tagpr）をマージすると、tagpr ワークフローの deploy-prd が prd の CDK をデプロイする。prd の apex は CFN 管理外の A レコード（Vercel 向け）を手で作っていたため、`route53.ARecord` の `deleteExisting` で消してから alias を作る。dev と同じ確認をする。

```bash
curl -sI https://shuntaka.dev/ | grep -iE '^(via|x-cache)'
curl -s -o /dev/null -w '%{http_code}\n' https://shuntaka.dev/api/health/db
curl -s 'https://shuntaka.dev/api/users/shuntaka/articles?perPage=1' | head -c 200
```

### 5. GitHub App（prd）の Webhook URL を変える

dev と同じ手順で、prd 用の App の Webhook URL を `https://shuntaka.dev/api/webhooks/github` に変えて push で確かめ、変数を消す。

```bash
gh variable delete WEB_BUILD_API_URL --env prd
```

### 6. 後片付け（prd の切り替え後）

Vercel の Git 連携を外す。PR ごとのプレビュービルドと GitHub のチェック（Vercel / Vercel Preview Comments）が止まる。ダッシュボードなら、Vercel の shuntaka-dev プロジェクト → Settings → Git → Connected Git Repository の Disconnect。CLI なら `vercel link` 済みの `apps/web` で実行する（リポジトリから `vercel` パッケージは外したので `bunx` で取ってくる）。

```bash
cd apps/web
bunx vercel@latest login
bunx vercel@latest git disconnect
```

GitHub 側でも止める場合は、Settings → Applications → Installed GitHub Apps → Vercel の Configure で、Repository access から shuntaka-dev を外す（ほかのリポジトリで使っていなければ Uninstall）。

Vercel プロジェクトの Settings → Domains から shuntaka.dev と shuntaka.me を外し、Settings → General の一番下からプロジェクトを削除する。使わなくなった secret を消す。

```bash
gh secret delete VERCEL_TOKEN
gh secret delete VERCEL_ORG_ID
gh secret delete VERCEL_PROJECT_ID
```

API Gateway 用だった Tokyo の証明書スタックを消す。どこからも参照しなくなっている。消したあと、`iac/aws/bin/cdk.ts` の `TokyoCertificateStack` と `config.ts` の `ssm.tokyo` を別の PR で外す。

```bash
cd iac/aws
bunx dotenv -- cdk destroy -c stageName=dev d-st-tokyo-cert
bunx dotenv -- cdk destroy -c stageName=prd p-st-tokyo-cert
```

`SiteConstruct` の `deleteExisting` を別の PR で外す（CDK で非推奨。失敗時にレコードが消えたままになり得る。prd の手作りのレコードを消すためだけに入れた）。

dev の管理外になったサブネット（`10.50.2.0/24`）は消した（済。手順と結果は [dev の巻き戻り](#dev-の巻き戻り2026-10-23)）。

## dev の巻き戻り（2026-10-23）

このブランチを dev にデプロイした後、main への別の push（#816）で旧構成の `deploy.yaml` が動き、旧コードで `st-tidb-proxy` を更新した。旧コードには 2 つ目のサブネットが無いため、CloudFormation が削除しようとした。

| リソース                                     | 結果                                                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| SSM `/tidb-proxy/vpc/private-subnet-id-2`    | 削除された                                                                                                               |
| 2 つ目のサブネットのルートテーブルと関連付け | 削除された（サブネットは VPC のメインのルートテーブル（ローカルルートのみ）に戻り、tidb-proxy への通信はそのまま通った） |
| サブネット `10.50.2.0/24`                    | connector の ENI が使っていて削除に失敗し（`DELETE_FAILED (skipped)`）、スタックの管理から外れて残った                   |
| main（dev）                                  | 旧ワークフローの `timeout-minutes: 30` で job が打ち切られ、反映されなかった                                             |

このままでは、main は SSM のパラメータが無いため、st-tidb-proxy は同じ CIDR のサブネットが残っているため、どちらもデプロイできない。2 つ目のサブネットを `10.50.3.0/24` に変えて作り直し、`st-tidb-proxy` → main の順にデプロイして connector を移した。

管理外のサブネットは 2026-10-23 に消した（下の実行結果）。消すまでに分かったことは次の 2 つ。

- connector の ENI は Lambda が管理するリソース（Operator が `network-connectors.lambda.amazonaws.com`、`HiddenByDefault: true`）で、`describe-network-interfaces` には `--include-managed-resources` を付けないと出てこない。付けずに見ると空に見えるが、`delete-subnet` は `DependencyViolation` で失敗する
- connector の構成を変えると新しいバージョンができ、古いバージョンは残る。古いバージョンが古いサブネットの ENI を持ち続けるため、バージョン付きの ARN（`…:network-connector:<id>:<version>`）で古いバージョンだけを消すと ENI が外れる。バージョンなしの ARN を渡すと connector 全体が消えて、使っている Web Function の外向き通信が止まる

手順は次のとおり。

```bash
VPC_ID=$(aws ssm get-parameter --name /tidb-proxy/vpc/id --query Parameter.Value --output text)
SUBNET_ID=$(aws ec2 describe-subnets --filters Name=vpc-id,Values=${VPC_ID} Name=cidr-block,Values=10.50.2.0/24 --query 'Subnets[0].SubnetId' --output text)

# 管理対象を含めて ENI を見る。connector のタグ (aws:lambda:networkConnectorId) で持ち主が分かる
aws ec2 describe-network-interfaces --include-managed-resources --filters Name=subnet-id,Values=${SUBNET_ID} \
  --query 'NetworkInterfaces[].[NetworkInterfaceId,Status,InterfaceType]' --output text

# 各バージョンのサブネットを見て、古いサブネットを含むバージョンを特定する
CONNECTOR_ARN=$(aws lambda-core get-network-connector --identifier d-st-blog-api --query Arn --output text)
aws lambda-core get-network-connector --identifier ${CONNECTOR_ARN}:1 --query Configuration.VpcEgressConfiguration.SubnetIds

# 古いバージョンだけを消す (必ずバージョン付きの ARN)。ENI が外れたらサブネットを消す
aws lambda-core delete-network-connector --identifier ${CONNECTOR_ARN}:1
aws ec2 delete-subnet --subnet-id ${SUBNET_ID}
```

実行結果（2026-10-23、dev。アカウント ID は伏せ、リソース ID は先頭だけ）。

| 時刻（JST） | 操作                                                                | 結果                                                                                                                |
| ----------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 14:15       | `describe-network-interfaces`（`--include-managed-resources` なし） | 空                                                                                                                  |
| 14:15       | `delete-subnet subnet-039e…`                                        | `DependencyViolation`（has dependencies and cannot be deleted）                                                     |
| 14:29       | `describe-network-interfaces --include-managed-resources`           | `eni-0f1c…` が 1 つ（`in-use`、`lambda`、タグ `aws:lambda:networkConnectorName=d-st-blog-api`）                     |
| 14:30       | `get-network-connector`（バージョン 1 / 2）                         | バージョン 1 は `10.50.2.0/24` + `10.50.1.0/24`、バージョン 2 は `10.50.3.0/24` + `10.50.1.0/24`（どちらも ACTIVE） |
| 14:31       | `delete-network-connector …:nc-…:1`                                 | バージョン 1 が `DELETING`。connector 本体（バージョン 2）は `ACTIVE` のまま                                        |
| 14:31       | 古いサブネットの ENI を再確認                                       | 0                                                                                                                   |
| 14:31       | `delete-subnet subnet-039e…`                                        | 削除できた                                                                                                          |
| 14:32       | `https://shuntaka.me/api/health/db` と検索 API                      | 204 / 200（connector 経由の通信は影響なし）                                                                         |

この PR を main にマージするまでは、main への push のたびに旧構成で dev がデプロイされる。ワークフローとコードは push されたコミットのものが使われるため、ブランチ側では防げない。マージまで main へのマージ（Renovate を含む）を止める。

## 料金（2026-10-23 の見積もり）

この見積もりはメモリを 2 GB × 稼働時間で数えているが、実際は実行環境が使ったメモリ（170〜240 MB）の分だけ課金されていた。メモリの金額はこの節の約 1/10 になる。実績は[料金の実績](#料金の実績2026-10-27-時点)を参照。

Web Functions の料金はほぼメモリで決まる。メモリは実行環境ごとに 2 GB 固定で、リクエストが無くても実行環境がある間ずっと課金される。費用は「実行環境が何台、何時間生きているか」で決まる。

### 単価（ap-northeast-1、Arm）

AWS の Price List API で確かめた。

```bash
aws pricing get-products --region us-east-1 --service-code AWSLambda \
  --filters Type=TERM_MATCH,Field=regionCode,Value=ap-northeast-1 --output json |
  jq -r '.PriceList[] | fromjson | select((.product.attributes | tostring) | test("web";"i"))
    | [.product.attributes.usagetype, (.terms.OnDemand[].priceDimensions[] | "\(.pricePerUnit.USD) / \(.unit)")] | @tsv'
```

| 項目       | 単価                    | 目安                                                                   |
| ---------- | ----------------------- | ---------------------------------------------------------------------- |
| メモリ     | $0.0000042688 / GB 秒   | 1 台 1 時間で約 $0.031。24 時間 30 日動き続けると 1 台で約 $22 / 月    |
| vCPU       | $0.0000322421 / vCPU 秒 | CPU を使った時間だけ。dev の実測は 4 時間で合計約 100 秒（$0.01 未満） |
| リクエスト | $0.30 / 100 万件        | ブログの規模ならほぼ 0                                                 |

### dev の実測

実行環境は 1 分ごとに `platform.invokeSummary`（`instanceId`、`requests`、`cpuTimeMs` を含む）をログに出す。実行環境ごとに数えると、生きていた分数が分かる。

```bash
for g in /aws/lambda-web/d-st-web /aws/lambda-web/d-st-blog-api-web; do
  echo "== $g"
  aws logs tail "$g" --since 5h --format short | grep 'platform.invokeSummary' |
    sed -E 's/^([0-9T:-]+) .*"instanceId":"([^"]+)".*"requests":([0-9]+).*"cpuTimeMs":([0-9.]+).*/\2 \1 \3 \4/' |
    awk '{ n[$1]++; r[$1]+=$3; c[$1]+=$4 } END { t=0; for (k in n) { printf "%s minutes=%d requests=%d cpu_s=%.1f\n", substr(k,1,8), n[k], r[k], c[k]/1000; t+=n[k] } print "total env-minutes=" t }'
done
```

2026-10-23 の 11:38〜15:27（JST）は、デプロイと動作確認で一番忙しかった時間帯で、次のとおりだった。

| 関数              | 実行環境の数 | 延べ稼働 | 金額（メモリ） |
| ----------------- | ------------ | -------- | -------------- |
| d-st-web          | 35           | 298 分   | 約 $0.15       |
| d-st-blog-api-web | 14           | 296 分   | 約 $0.15       |

- 実行環境は最後のリクエストから 5〜7 分ほどで消え、リクエストが無ければ 0 台になる
- デプロイ直後などに 6〜8 台が同時に立ち上がることがあった。1 台あたり数分〜十数分で消える

### 定常時の見込みと対策

対策前は、監視（EventBridge の API Destination が `/health/db` を叩く）が 5 分ごとだった。実行環境が消える前に次の監視が来るため、blog-api の実行環境が常に 1 台残っていた（1 段階あたり約 $22 / 月）。Next.js は CloudFront のキャッシュ切れのときだけ呼ばれ、アクセスが数分おきに来るなら実質ずっと 1 台残る（$0〜22 / 月）。dev と prd を合わせると $30〜90 / 月で、旧構成（Lambda + API Gateway はほぼ $0、Vercel）より増える。

また endpoint に台数の上限が無く、bot などで急に増えるとアカウントの vCPU の上限まで実行環境が増え得た（例えば 100 台が 1 日動くと約 $74）。

| 対策                | dev    | prd       | 効果                                                                                                     |
| ------------------- | ------ | --------- | -------------------------------------------------------------------------------------------------------- |
| `maxEnvironments`   | 2      | 3         | 最悪でも、関数ごとに上限台数 × $22 / 月で頭打ちになる。1 台で 64 並列まで捌けるので、ブログには十分      |
| `/health/db` の監視 | 止める | 30 分ごと | 監視で起こした実行環境は 5〜7 分で消えるので、blog-api の常駐は 30 分のうち 2 割強に下がる（約 $5 / 月） |

設定は `iac/aws/lib/config.ts` の `webFunction.maxEnvironments` と `observability.healthcheckProbeIntervalMinutes`。監視の間隔を実行環境が消える時間より長くすると、db.healthcheck.duration にコールドスタート込みの値が入る。これは元々の監視の意図（`observability-construct.ts` のコメント）にも合う。

対策後の見込みは、dev がほぼ $0（触ったときだけ）、prd が $5〜50 / 月（アクセス次第。上限 3 台）。ほかの料金は次のとおりで小さい。

- CloudFront: 常時無料枠（月 1 TB、1,000 万リクエスト、CloudFront Functions 200 万回）に収まる見込み
- egress network connector: 時間課金は無い。VPC との間のデータ転送は同一リージョン内の料金で、別 AZ を通る分は $0.01 / GB
- S3 のコード置き場: デプロイごとに約 18 MB の zip が残る（prune しない）。100 回で約 1.8 GB、月 $0.05 ほど

予算のアラートは CDK では作っていない。AWS Budgets で月の予算を手で作る。既にあるかを確かめてから作る。

```bash
aws budgets describe-budgets --account-id <account-id> --query 'Budgets[].BudgetName'
aws budgets create-budget --account-id <account-id> \
  --budget '{"BudgetName":"monthly-total","BudgetLimit":{"Amount":"30","Unit":"USD"},"TimeUnit":"MONTHLY","BudgetType":"COST"}' \
  --notifications-with-subscribers '[{"Notification":{"NotificationType":"FORECASTED","ComparisonOperator":"GREATER_THAN","Threshold":100,"ThresholdType":"PERCENTAGE"},"Subscribers":[{"SubscriptionType":"EMAIL","Address":"<email>"}]}]'
```

### 次の料金比較の観点

prd を切り替えたあと、実際の請求で旧構成と比べる。見積もりと実績がずれたら、どこがずれたかが分かるように観点を揃えておく。

比べ方は次のとおり。

- 期間: 暦月で比べる。切り替えた月は旧構成と新構成が混ざるので外す（例: 旧構成は 2026-09、新構成は切り替えの翌月）
- stage: dev と prd を分ける。Cost Explorer では分けられない項目（Web Functions の使用量など）は、関数名（`d-st-*` / `p-st-*`）ごとのログ集計で按分する
- 正規化: アクセス数で割った値（1 万リクエストあたりの費用）も見る。アクセスが増えて高くなったのか、構成のせいで高くなったのかを分けるため

項目ごとの対応は次のとおり。

| 観点           | 新構成                                                              | 旧構成                                             | 取り方                                         |
| -------------- | ------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------- |
| 計算（メモリ） | `Lambda-Web-Memory-GB-Second-ARM`（実行環境がある間ずっと）         | Lambda の GB 秒（Event Function、実行中だけ）      | Cost Explorer の USAGE_TYPE                    |
| 計算（CPU）    | `Lambda-Web-vCPU-Second-ARM`                                        | （GB 秒に含まれる）                                | Cost Explorer の USAGE_TYPE                    |
| リクエスト     | `Lambda-Web-Request-ARM`、CloudFront のリクエスト                   | API Gateway REST のリクエスト、Lambda のリクエスト | Cost Explorer の USAGE_TYPE                    |
| 配信           | CloudFront のデータ転送（無料枠を超えたか）                         | Vercel のプランと従量分                            | Cost Explorer、Vercel の請求                   |
| ネットワーク   | AZ 間のデータ転送（connector の 1c の ENI → 1a の tidb-proxy）      | なし（1a のみ）                                    | Cost Explorer の `DataTransfer-Regional-Bytes` |
| 監視           | EventBridge の API Destination（prd 30 分ごと）                     | 同（dev / prd とも 5 分ごと）                      | Cost Explorer                                  |
| 保存           | S3 のコード置き場（zip が溜まる）、ECR（Event Function のイメージ） | ECR                                                | S3 のバケットサイズ、Cost Explorer             |
| 固定費         | なし                                                                | Vercel のプラン                                    | Vercel の請求                                  |

料金の背景として、次の使い方の指標も残す。

- 実行環境の延べ稼働（env-minutes）と、同時に立っていた台数の最大（上の dev の実測と同じ集計）
- `maxEnvironments` に当たって絞られたか（CloudFront の 5xx / 429 の割合）
- アクセス数（CloudFront の Requests、ページビュー）

金額以外に、次も一緒に比べる。

- 体感の速さ: TTFB、コールドスタートの頻度と時間（db.healthcheck.duration、CloudFront のオリジンの応答時間）
- 運用: デプロイにかかる時間、手作業の量（Vercel の操作が無くなった分、CDK の synth が重くなった分）

Cost Explorer からは次で取れる。

```bash
aws ce get-cost-and-usage --time-period Start=2026-11-01,End=2026-12-01 --granularity MONTHLY \
  --metrics UnblendedCost UsageQuantity \
  --filter '{"Dimensions":{"Key":"SERVICE","Values":["AWS Lambda","Amazon CloudFront","Amazon API Gateway","Amazon EC2","Amazon EventBridge"]}}' \
  --group-by Type=DIMENSION,Key=USAGE_TYPE
```

stage を Cost Explorer で分けたくなったら、スタックにタグ（例: `stage`）を付けてコスト配分タグとして有効にする（今は付けていない）。

## 料金の実績（2026-10-27 時点）

prd は 2026-10-23 の 16 時ごろ（JST）に切り替えた。切り替え後の丸 1 日が取れる 10-24〜26（UTC の日。Cost Explorer の日の区切りに合わせた）で集計した。暦月での比較は[次の料金比較の観点](#次の料金比較の観点)のとおり 2026-11 が終わってから行う。ここでは日次の速報を残す。

### メモリは使った分だけ課金される

Web Functions のメモリは、実行環境が使ったメモリの分だけ課金されていた。見積もりは 2 GB × 稼働時間で数えていたため、約 10 倍に見積もっていた。料金ページの計算例も、消費したメモリ（0.49 GB）× 秒で計算している（[pricing](https://aws.amazon.com/lambda/pricing/)）。

`platform.invokeSummary` は実行環境ごとに 1 分おきに `maxMemoryUsageMb` を出す。その合計 × 60 秒が、Cost Explorer の `APN1-Lambda-Web-Memory-GB-Second-ARM` とほぼ一致した（4 関数の合計）。

| 日（UTC） | Cost Explorer の GB 秒 | ログの maxMemoryUsageMb × 60 秒 | 2 GB × 稼働時間（見積もりの数え方） |
| --------- | ---------------------- | ------------------------------- | ----------------------------------- |
| 10-23     | 37,122                 | 38,519                          | 382,560                             |
| 10-24     | 43,318                 | 44,714                          | 440,160                             |
| 10-25     | 37,566                 | 39,096                          | 396,240                             |

リクエスト数もログの合計と Cost Explorer の `APN1-Lambda-Web-Request-ARM` が一致した（10-24 は両方 3,019 件）。

使っているメモリは blog-api が約 170 MB、Next.js が約 240 MB（最大 386 MB）。1 台が 30 日動き続けたときのメモリ代は、blog-api が約 $1.9、Next.js が約 $2.6 になる（見積もりの約 $22 ではない）。

Web Functions には Lambda の無料枠が効かない。Event Function など（`APN1-Lambda-GB-Second-ARM`）は 0 円のままで、Web Functions の使用量は最初から課金されている。

### Web Functions の費用

Cost Explorer の日次。10-26 はまだ締まっていない（tidb-proxy の Fargate が通常の 6 割しか計上されていない）ので外した。

| 日（UTC） | メモリ | vCPU   | リクエスト | 計     |
| --------- | ------ | ------ | ---------- | ------ |
| 10-24     | $0.185 | $0.020 | $0.001     | $0.206 |
| 10-25     | $0.160 | $0.019 | $0.001     | $0.180 |

1 日あたり約 $0.19、30 日で約 $5.8。関数ごとにはログから按分した（10-24〜26 の平均）。

| 関数              | リクエスト / 日 | 1 台以上いた時間 | 平均メモリ | コールドスタート / 日 | 30 日換算 |
| ----------------- | --------------- | ---------------- | ---------- | --------------------- | --------- |
| p-st-web          | 1,370           | 66%              | 237 MB     | 122                   | 約 $2.5   |
| p-st-blog-api-web | 447             | 68%              | 172 MB     | 144                   | 約 $2.2   |
| d-st-web          | 1,028           | 23%              | 233 MB     | 49                    | 約 $0.9   |
| d-st-blog-api-web | 203             | 15%              | 173 MB     | 25                    | 約 $0.3   |

prd が約 $4.7 / 月、dev が約 $1.2 / 月。見積もり（prd $5〜50、dev ほぼ $0）と比べると、prd は下限あたり、dev は少し上だった。

- prd は 1 日の 2/3 の時間で実行環境が 1 台以上いる。1 台は平均 10 分ほどで消え、関数ごとに 1 日 120〜140 回ほど立ち上がる
- p-st-blog-api-web はリクエストが 1 日 450 件ほどなのに、1 台以上いた時間（3 日で 2,921 分）の約半分（1,395 分）で 2 台が同時にいた。理由は未確認
- 1 分ごとの台数の最大は p-st-blog-api-web の 5（prd の上限は 3）。1 分の区切りで数えているので、入れ替わる前後の実行環境が重なって数えられたものと見られる（未確認）
- dev にも Next.js へ 1 日 1,000 件ほどのリクエストが来ている
- 上限まで常駐したときは、今のメモリ使用量なら prd で 3 台 × 2 関数 ≈ $13 / 月になる。負荷でメモリが増えればその分上がる

### ほかの料金

- CloudFront: 無料枠に収まった。1 日 3,000〜3,900 リクエスト、転送 0.02〜0.03 GB
- AZ 間のデータ転送（`APN1-DataTransfer-Regional-Bytes`）: 1 日 0.01〜0.03 GB で 0 円
- API Gateway REST: 10-24 以降は使われていない（`APN1-ApiGatewayRequest` が 0 件）

### 旧構成（2026-09）との比較

| 項目                                  | 旧構成（2026-09 の請求）                  | 新構成（30 日の見込み） |
| ------------------------------------- | ----------------------------------------- | ----------------------- |
| Web Functions                         | なし                                      | 約 $5.8                 |
| Lambda（Event Function など）         | $0（無料枠。約 5,900 GB 秒、約 3.9 万件） | $0（無料枠）            |
| API Gateway REST                      | $0.09（19,672 件）                        | なし                    |
| CloudFront                            | なし                                      | $0（無料枠）            |
| 共通（tidb-proxy、Route 53、S3 など） | $17.14                                    | 同じ                    |
| Vercel                                | 未確認                                    | なし                    |
| 計（税抜）                            | $17.23 + Vercel                           | 約 $23                  |

共通分の内訳（2026-09）は、tidb-proxy の Fargate が $8.86、Public IPv4 が $3.60、Route 53 が $2.03、S3 が $1.29、Secrets Manager が $0.80、CloudWatch が $0.33、ECR が $0.15。

日次の合計で見ても、切り替え前（10-02〜10-22）の 1 日約 $0.47 が、切り替え後（10-24〜25）は約 $0.67 になった。差の $0.19 / 日（30 日で約 $5.8）は Web Functions の費用とほぼ同じ。AWS 側は月 $6 ほど増え、Vercel の分が無くなる。

### 集計に使ったコマンド

AWS の認証は `aws-vault exec private`（ブログのアカウント）。Cost Explorer は UTC の日で区切られる。

```bash
aws ce get-cost-and-usage --region us-east-1 --time-period Start=2026-10-01,End=2026-10-28 --granularity DAILY \
  --metrics UnblendedCost UsageQuantity --group-by Type=DIMENSION,Key=USAGE_TYPE
```

関数ごとの使用量は Logs Insights で集計した（`START` / `END` は UNIX 秒）。

```bash
G="/aws/lambda-web/d-st-web /aws/lambda-web/d-st-blog-api-web /aws/lambda-web/p-st-web /aws/lambda-web/p-st-blog-api-web"
# 日ごとの延べ稼働（分）、リクエスト、CPU、メモリ（maxMemoryUsageMb の合計 × 60 / 1024 が GB 秒）
aws logs start-query --log-group-names $G --start-time $START --end-time $END --query-string \
  'filter type = "platform.invokeSummary"
   | stats count(*) as envMin, sum(record.metrics.requests) as req, sum(record.metrics.cpuTimeMs) as cpuMs,
       sum(record.metrics.maxMemoryUsageMb) as memMbMin by @log, bin(1d) as day'
# コールドスタートの回数
aws logs start-query --log-group-names $G --start-time $START --end-time $END --query-string \
  'filter type = "platform.initStart" | stats count(*) as inits by @log, bin(1d) as day'
# 1 分ごとの台数（--limit 10000 で全行を取り、手元で最大と分布を数える）
aws logs start-query --log-group-names $G --start-time $START --end-time $END --limit 10000 --query-string \
  'filter type = "platform.invokeSummary"
   | stats count_distinct(record.instanceId) as n by @log, datefloor(@timestamp, 1m) as minute'
aws logs get-query-results --query-id <queryId>
```

1 分ごとの台数は `bin(1m) as m` で書くと分ごとに分かれず、`@log` ごとの 1 行になった。`datefloor` を使う。

## 未検証事項

- connector の ENI が別 AZ（1c）にある場合の tidb-proxy（1a）までの経路と、AZ 間転送の量
- invalidation の custom resource が endpoint の切り替え後に走ること（endpoint の更新完了が、新しい revision へのルーティング完了を意味するか）
- musl の malloc の性能。遅い場合は mimalloc などのアロケータを入れる
- Web Functions が zip 内のシンボリックリンクを残して展開するか（apps/web の zip はリンクを含む。残らない場合は standalone を hoisted な node_modules で作り直す）
- swagger UI（`/api/swagger`）は `openapi.json` を絶対パス `/swagger/openapi.json` で読むため、CloudFront 経由では JSON の取得が 404 になる
- 実行環境が消えるまでの時間（dev の実測では最後のリクエストから 5〜7 分。ドキュメントには書かれておらず、変わり得る）
- IamAuth の endpoint で viewer の `Authorization` が残るか（HTTP ページは削除と書き、アクセス制御ページは `AWS4-` で始まる値のみ削除と書いている）
- p-st-blog-api-web で、リクエストが少ないのに 2 台が同時にいる時間が長い理由（[料金の実績](#料金の実績2026-10-27-時点)）
