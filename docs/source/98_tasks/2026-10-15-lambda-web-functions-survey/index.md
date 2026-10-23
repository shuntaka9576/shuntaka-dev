# Lambda Web Functions + CloudFront OAC への移行検討（blog-api / apps/web / admin-api）

- 起票日: 2026-10-15
- 対象: blog-api（Rust / Axum）、apps/web（Next.js 16 / Vercel）、admin-api（Hono）、proxy VPC
- ステータス: 実装済み・未デプロイ（2026-10-23）。blog-api は案 C（Node.js から Rust バイナリを子プロセスで起動）、API は `https://<fqdn>/api/*` に統合して `api.<fqdn>` を撤去する。admin-api は対象外。デプロイと切り替えは[切り替え手順](#切り替え手順)のとおり
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

| 項目                   | 内容                                                                                                                                                                                    | 出典                                                                                                                                                                                                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ランタイム             | `nodejs24.x`（arm64）のみ。Node.js 以外は Event Functions か MicroVMs を使うよう案内されている                                                                                          | [web-functions](https://docs.aws.amazon.com/lambda/latest/dg/web-functions.html)                                                                                                                                                                                              |
| コード                 | バージョニング有効な S3 バケットの .zip のみ（展開後 512 MB まで）。コンテナイメージは不可。バケットポリシーで `lambda.amazonaws.com` に読み取りを許可する                              | [code-s3](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-code-s3.html)                                                                                                                                                                                            |
| 実行環境               | メモリ 2 GB 固定。`maxConcurrencyPerEnvironment` は 1〜128（デフォルト 64）                                                                                                             | [runtimes](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-runtimes.html#web-functions-runtimes-memory) / [CFN ServiceConfig](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-lambda-webfunctionrevision-serviceconfig.html) |
| タイムアウト           | 3〜900 秒（デフォルト 30 秒）                                                                                                                                                           | [CFN ServiceConfig](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-lambda-webfunctionrevision-serviceconfig.html)                                                                                                                      |
| 入口                   | Lambda が HTTPS エンドポイントを提供（HTTP/1.1）。カスタムドメインと WAF は CloudFront を前段に置く。WebSocket は不可                                                                   | [networking](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-networking.html)                                                                                                                                                                                      |
| イベント               | HTTP のみ。イベント駆動の処理は Event Functions を使う                                                                                                                                  | [web-functions](https://docs.aws.amazon.com/lambda/latest/dg/web-functions.html)                                                                                                                                                                                              |
| VPC                    | egress network connector で VPC へ出る。別 AZ のサブネット 2 つ以上が必要。connector 自体はインターネットへの出口を提供しない（NAT が必要）。`HomeRegion` の endpoint のみ              | [networking](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-networking.html#web-functions-networking-vpc)                                                                                                                                                         |
| CloudFront OAC         | signing behavior は `always-amz-auth` のみ。PUT / POST / PATCH は `UNSIGNED-PAYLOAD` で署名するため `x-amz-content-sha256` は不要。viewer の `Authorization` は上書きされず関数まで届く | [CloudFront: Lambda Web Function origin](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda-web.html#oac-signing-behavior-lambda-web)                                                                            |
| Lambda@Edge            | OAC 付きの Web Function オリジンのビヘイビアでは origin request / origin response トリガーを使えない（CloudFront Functions は使える）                                                   | [CloudFront: Lambda Web Function origin](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda-web.html#oac-prerequisites-lambda-web)                                                                               |
| 料金（us-east-1, Arm） | $0.30 / 100 万リクエスト、$0.0000276944 / vCPU 秒（CPU を使った時間のみ）、$0.0000036667 / GB 秒（実行環境が存在する間）                                                                | [pricing](https://aws.amazon.com/lambda/pricing/)                                                                                                                                                                                                                             |

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
| VPC 接続         | proxy VPC に `ap-northeast-1c` の Private Isolated サブネット（`10.50.2.0/24`）を足し、blog-api の Web Function だけに egress network connector を付ける。SG は Event Function と共有                                         |
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

## 切り替え手順

apex を CloudFront に向け直す初回だけ、next build の時点ではまだ `https://<fqdn>/api` が無いため、`WEB_BUILD_API_URL` で旧 API を指す。dev → prd の順で行う。

dev（main へのマージで自動デプロイ）の前に、GitHub Environments の dev に変数を入れる。

```bash
gh variable set WEB_BUILD_API_URL --env dev --body 'https://api.shuntaka.me'
```

デプロイの順は `st-tidb-proxy`（別 AZ のサブネット）→ `st-tidb-proxy-logs` → main（GlobalDns と virginia-cert を含む）→ admin。dev の apex は GlobalDnsStack が先に Vercel 向けの A レコードを消すため、main の完了まで shuntaka.me は落ちる。

デプロイ後に GitHub App（dev）の Webhook URL を `https://shuntaka.me/api/webhooks/github` に変え、変数を消す。

```bash
gh variable delete WEB_BUILD_API_URL --env dev
```

prd はリリース PR のマージ前に変数を入れる。GTM / Clarity の ID は Vercel の Production 環境変数から移す。

```bash
gh variable set WEB_BUILD_API_URL --env prd --body 'https://api.shuntaka.dev'
gh variable set NEXT_PUBLIC_GOOGLE_TAG_MANAGER_ID --env prd --body 'GTM-XXXXXXX'
gh variable set NEXT_PUBLIC_CLARITY_PROJECT_ID --env prd --body 'xxxxxxxxxx'
```

prd の apex は CFN 管理外の A レコード（Vercel 向け）を手で作っていたため、`route53.ARecord` の `deleteExisting` で消してから alias を作る。デプロイ後に GitHub App（prd）の Webhook URL を `https://shuntaka.dev/api/webhooks/github` に変え、変数を消す。

```bash
gh variable delete WEB_BUILD_API_URL --env prd
```

後片付け。

- Vercel プロジェクトからドメインを外して削除し、`VERCEL_TOKEN` / `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID` の secret を消す
- `d-st-tokyo-cert` / `p-st-tokyo-cert`（API Gateway 用の証明書。どこからも参照しなくなった）を `cdk destroy` する
- 切り替えが済んだら `SiteConstruct` の `deleteExisting` を外す（CDK で非推奨。失敗時にレコードが消えたままになり得る）

## 未検証事項

- egress network connector の ENI から `tidb-proxy.internal`（Cloud Map の private DNS）を引けるか
- Web Function 上で Rust の AWS SDK が認証情報を取れるか（`AWS_ACCESS_KEY_ID` などは予約済みの環境変数として Lambda が設定する想定）。Event invoke はここに依存する
- connector の ENI が別 AZ（1c）にある場合の tidb-proxy（1a）までの経路と、AZ 間転送の量
- invalidation の custom resource が endpoint の切り替え後に走ること（endpoint の更新完了が、新しい revision へのルーティング完了を意味するか）
- musl の malloc の性能。遅い場合は mimalloc などのアロケータを入れる
- Web Functions が zip 内のシンボリックリンクを残して展開するか（apps/web の zip はリンクを含む。残らない場合は standalone を hoisted な node_modules で作り直す）
- swagger UI（`/api/swagger`）は `openapi.json` を絶対パス `/swagger/openapi.json` で読むため、CloudFront 経由では JSON の取得が 404 になる
- アクセスがなくなってから実行環境が消えるまでの時間（2 GB 固定のメモリ課金に効く。ドキュメントで見つけられなかった）
- IamAuth の endpoint で viewer の `Authorization` が残るか（HTTP ページは削除と書き、アクセス制御ページは `AWS4-` で始まる値のみ削除と書いている）
