# Lambda Web Functions + CloudFront OAC への移行検討（blog-api / apps/web / admin-api）

- 起票日: 2026-10-15
- 対象: blog-api（Rust / Axum）、apps/web（Next.js 16 / Vercel）、admin-api（Hono）、proxy VPC
- ステータス: 検討のみ（保留）。blog-api が Rust のため、Web Functions への移行方式が決まっていない。実装・デプロイは未着手
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

## 未決事項

- blog-api の方式（A〜D）
- API を `shuntaka.dev/api/*` にまとめるか、`api.shuntaka.dev` のまま残すか（まとめると同一オリジンになり CORS が不要）
- `next/image` の最適化をどこで行うか

## 未検証事項

- `addPropertyOverride` で `EgressNetworkConnectorArn` を設定できるか
- アクセスがなくなってから実行環境が消えるまでの時間（2 GB 固定のメモリ課金に効く。ドキュメントで見つけられなかった）
- `AWS::Lambda::ResourcePolicy` のプロパティ名（CloudFormation のドキュメントが `FunctionResourceArn` と `ResourceArn` で食い違っている。CDK L1 は `ResourceArn`）
- IamAuth の endpoint で viewer の `Authorization` が残るか（HTTP ページは削除と書き、アクセス制御ページは `AWS4-` で始まる値のみ削除と書いている）
