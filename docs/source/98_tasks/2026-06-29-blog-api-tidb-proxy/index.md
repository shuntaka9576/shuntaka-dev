# blog-api: Lambda + tsnet を VPC + Fargate Proxy 構成に移行

- 起票日: 2026-06-29
- 移行元: Lambda (no VPC) + tsnet sidecar で直接 Tailnet 参加
- 移行先: Lambda (VPC enabled) + Fargate Spot proxy (Tailnet 終端 + forward proxy)
- 対象環境: **dev / prd で共用 1 proxy**（インフラ実体は 1 つ、両 stage の Lambda が同じ proxy 経由で TiDB に接続）
- ステータス: 計画策定済み（レビュー反映済み）
- 関連調査: [Tailscale + Lambda の ephemeral ノード蓄積](../../97_survey/2026-06-29-tailscale-lambda-ephemeral-pileup/index.md)
- 関連実装: `apps/blog-api/tsnet-launcher/main.go`, `iac/aws/lib/api/blog-api-construct.ts`

## 概要

blog-api Lambda が Tailscale ノードとして Tailnet に直接参加する現行構成 (tsnet sidecar) を廃止し、**VPC 内に置いた Fargate Spot proxy が Tailnet 終端 + forward proxy を担う構成**に切り替える。Lambda 自体は Tailnet に参加しなくなる。

主目的:

1. **Tailscale Pricing v4 (2026-04 施行) の ephemeral resource-minutes 枯渇問題を構造的に解消する**。Personal/Standard プランの 1,000 mins/月 上限は、Lambda cold start ごとに新規 ephemeral ノードを作る現行構成では到底収まらない（悲観試算で月 16 cold start 相当が上限）。Tailscale 側は将来 enforce を開始する旨を公式に予告している。
2. **admin console に毎日蓄積される `blog-api-lambda-N` 連番ノードを廃止し**、Tailscale 上のノードを「**常駐 proxy 1 個（dev / prd 共用）**」に固定する。
3. **Lambda コンテナ内の Go sidecar (tsnet-launcher) を撤去**して image を小さくし、cold start を僅かに改善する。

### 設計判断の前提

- **SPOF は許容**: 個人ブログ用途。Vercel 側のキャッシュもあり、proxy 数十秒〜数分のダウンタイムは許容範囲。コストと実現可能性とセキュリティを優先し、proxy は **dev / prd ともに 1 task 構成**。
- **GitHub Webhook の auto-redelivery は無い**点には注意（後述）。proxy 中断中に着信した webhook は欠損しうるが、運用上の影響は重視しない。

## アーキテクチャ

### Before (現行)

```
                              Tailscale Control Plane
                                       ↑
                                       │ ephemeral ノード登録 ×N
                                       │
   Lambda container (no VPC)           │
   ├─ tsnet-launcher (Go) ─────────────┘
   │   ├─ tsnet.Server.Up()   ← cold start 毎に新規ノード
   │   ├─ 127.0.0.1:13306 listener
   │   └─ TCP forward to tidb.<tailnet>:4000 via Tailscale
   └─ Rust HTTP server
       └─ DATABASE_URL = mysql://127.0.0.1:13306/...
```

### After (本タスク)

```
Shared VPC (dev + prd 共用)
├─ Public subnet
│   └─ ECS Service (Fargate Spot, desiredCount=1)  ← dev/prd 共用 1 個
│       └─ Task: tidb-proxy
│           ├─ tsnet-forwarder (Go, 既存 tsnet-launcher を流用)
│           │   ├─ tsnet.Server.Up() ← 1 device 固定（reusable auth key）
│           │   └─ 0.0.0.0:13306 → tidb.<tailnet>:4000 via ts.Dial
│           ├─ squid: 0.0.0.0:3128 (HTTP forward proxy)
│           └─ Cloud Map に tidb-proxy.internal として private DNS 登録
└─ Private subnet
    ├─ Lambda (dev stage, VPC enabled, lambda-sg-dev)
    │   ├─ DATABASE_URL = mysql://tidb-proxy.internal:13306/blog_dev
    │   ├─ HTTPS_PROXY = http://tidb-proxy.internal:3128
    │   └─ Rust HTTP server のみ
    └─ Lambda (prd stage, VPC enabled, lambda-sg-prd)
        ├─ DATABASE_URL = mysql://tidb-proxy.internal:13306/blog_prd
        ├─ HTTPS_PROXY = http://tidb-proxy.internal:3128
        └─ Rust HTTP server のみ

                         Tailscale Control Plane
                                    ↑
                                    │ 1 device (dev/prd 共用)
                                    │
                        Fargate proxy のみが Tailnet に参加
```

### dev / prd 共用構成と環境差分

infra 本体は 1 つにまとめ、**Lambda 側の DATABASE_URL と SG だけ env で分ける**。proxy は両 stage が共有する。

| 項目                      | 共通 / env 別 | 内容                                         |
| ------------------------- | ------------- | -------------------------------------------- |
| VPC                       | 共通          | 1 VPC                                        |
| ECS cluster / service     | 共通          | 1 個                                         |
| Fargate task spec         | 共通          | 0.25 vCPU / 0.5 GB ARM Spot                  |
| Cloud Map namespace       | 共通          | `internal`                                   |
| proxy DNS 名              | 共通          | `tidb-proxy.internal`                        |
| Tailscale tag             | 共通          | `tag:proxy`                                  |
| Tailscale auth key SSM 名 | 共通          | `/shared/shuntaka/tailscale/proxy-auth-key`  |
| TiDB 接続先 (Tailnet)     | 共通          | `tidb.<tailnet>:4000`                        |
| Lambda VPC subnet         | 共通          | private subnet                               |
| Lambda SG                 | **env 別**    | `lambda-sg-dev` / `lambda-sg-prd`            |
| 接続先 database           | **env 別**    | `blog_dev` / `blog_prd`                      |
| MySQL user / password     | **env 別**    | `blog_dev` / `blog_prd` ユーザー（権限分離） |

ACL: `tag:proxy` → `tag:k8s`（TiDB）への ingress を 1 ルールで許可。env 分離は **TiDB のユーザー権限** と **Lambda SG** の 2 段で担保。

#### 共用にすることのトレードオフ

- ✅ コスト半減（後述）
- ✅ Tailscale device も 1 個固定（admin console もより綺麗）
- ✅ CDK stack 構造もシンプル
- ⚠ proxy 障害時に dev / prd 両方が落ちる（個人ブログかつ SPOF 受容方針なので許容）
- ⚠ proxy のメンテ（image 更新）も両 stage に同時影響

## なぜ Fargate (on-demand) か

| 観点          | Fargate on-demand        | Fargate Spot                                                   | EC2 t4g.nano + EIP          |
| ------------- | ------------------------ | -------------------------------------------------------------- | --------------------------- |
| 月額          | ~$12.1                   | ~$7.4                                                          | ~$4.5                       |
| IP 管理       | Cloud Map 自動更新       | Cloud Map 自動更新                                             | EIP で完全固定              |
| 障害復旧      | ECS が task を自動再起動 | ECS が task を自動再起動 (capacity 枯渇時は別 AZ 待ちで詰まる) | 自分で systemd / ASG を設定 |
| OS パッチ管理 | 不要 (managed image)     | 不要 (managed image)                                           | apt-get upgrade 等の運用    |
| 中断頻度      | なし                     | 2 分警告ありで稀に中断 + capacity 枯渇で再配置不可             | なし                        |

検証中に Spot capacity 枯渇 (`Capacity is unavailable at this time. Please try again later or in a different availability zone.`) で task が数十分置き直せない事象が発生。1 task しか動かさない構成では Spot 障害時に proxy ごと止まり dev / prd 両 stage が同時停止するため、月 $5 増えても on-demand を採用。SPOF はそのまま許容。

## コスト試算

**dev / prd 共用 1 proxy 前提**で計算（infra 全体で 1 個）。当初は Fargate Spot を想定していたが、Spot は ap-northeast-1a で稀に capacity 枯渇が起きて task 再起動が長時間止まる事象が発生したため、1 task しかない用途では割が合わないと判断して **on-demand (FARGATE) base=1 構成に変更**。差額は月 $5 程度。

| 要素                                         | 月額 (USD)    |
| -------------------------------------------- | ------------- |
| Fargate 0.25 vCPU / 0.5 GB (ARM, on-demand)  | ~$7.7         |
| Public IPv4 attached ($0.005/h × 730h)       | $3.65         |
| AWS Cloud Map private namespace              | $0.50         |
| AWS Cloud Map registered resource ($0.10/月) | $0.10         |
| AWS Cloud Map DNS queries                    | ~$0.05        |
| Lambda VPC enable                            | $0            |
| NAT Gateway                                  | $0 (使わない) |
| VPC Endpoint                                 | $0 (使わない) |
| ECR storage (image 最新 1 件のみ保存、共用)  | ~$0.05        |
| データ転送 outbound                          | 数十円程度    |
| **合計 (dev + prd 共用)**                    | **~$12.1**    |

Tailscale Premium ($18/user/月) でゴリ押しするより安く済む。

## IaC 構成: CDK は infra、ecspresso は task / service

参考: `~/repos/github.com/shuntaka9576/sqs-ecs-polling-worker` の構成パターンを踏襲。

### 責任分界

| 層               | ツール        | 管理対象                                                               |
| ---------------- | ------------- | ---------------------------------------------------------------------- |
| インフラ         | **CDK**       | VPC, ECS Cluster, ECR Repository, IAM Roles, Log Group, SG, SSM Params |
| Task / Service   | **ecspresso** | TaskDefinition, ECS Service, deployment                                |
| アプリケーション | Docker        | コンテナ image (alpine + tsnet-forwarder + squid)                      |

CDK は「インフラのスキャフォールド」を作るだけ。daily な image 更新や task definition 変更は ecspresso で完結する。

### CDK 側 (`iac/aws/lib/proxy/tidb-proxy-construct.ts`)

作るもの:

- VPC（既存があれば再利用、無ければ最小 1AZ）
- ECS Cluster `tidb-proxy`
- ECR Repository `tidb-proxy`（**lifecycle policy: 最新 1 image のみ保存**）
- IAM TaskRole（SSM 読み取り権限など）
- IAM ExecutionRole（ECR pull / Logs write）
- CloudWatch Log Group `/ecs/tidb-proxy`
- Security Group `tidb-proxy-sg`
- Cloud Map private namespace `internal` + service `tidb-proxy`
- 上記すべての ARN / ID / Name を SSM Parameter Store に格納:
  - `/tidb-proxy/vpc/public-subnet-id-1`
  - `/tidb-proxy/proxy/task-role`
  - `/tidb-proxy/proxy/task-exec-role`
  - `/tidb-proxy/proxy/sg-id`
  - `/tidb-proxy/proxy/log-group-name`
  - `/tidb-proxy/proxy/cluster-name`
  - `/tidb-proxy/proxy/ecr-repository-uri`
  - `/tidb-proxy/proxy/service-name`

ECR の lifecycle rule (CDK):

```typescript
new ecr.Repository(this, 'EcrRepository', {
  repositoryName: 'tidb-proxy',
  lifecycleRules: [
    {
      description: 'Keep only the latest 1 image',
      maxImageCount: 1,
      rulePriority: 1,
    },
  ],
});
```

### ecspresso 側 (`iac/aws/ecspresso/tidb-proxy/`)

```
iac/aws/ecspresso/tidb-proxy/
├── ecspresso.jsonnet         # entry point (cluster / service / file 指定)
├── ecs-task-def.jsonnet      # task definition (image / env / log driver)
├── ecs-service-def.jsonnet   # service config (subnet / SG / desiredCount)
├── ssm-params.jsonnet        # CDK が出力した SSM パラメータの参照
└── image-tag.jsonnet         # IMAGE_TAG 環境変数を読む
```

#### ssm-params.jsonnet (主要部)

```jsonnet
local projectName = 'tidb-proxy';
{
  serviceName: 'tidb-proxy',
  ssm: {
    vpc: {
      publicSubnetId1: '{{ ssm `/' + projectName + '/vpc/public-subnet-id-1` }}',
    },
    proxy: {
      taskRole: '{{ ssm `/' + projectName + '/proxy/task-role` }}',
      taskExecRole: '{{ ssm `/' + projectName + '/proxy/task-exec-role` }}',
      sgId: '{{ ssm `/' + projectName + '/proxy/sg-id` }}',
      logGroupName: '{{ ssm `/' + projectName + '/proxy/log-group-name` }}',
      clusterName: '{{ ssm `/' + projectName + '/proxy/cluster-name` }}',
      ecrRepositoryUri: '{{ ssm `/' + projectName + '/proxy/ecr-repository-uri` }}',
    },
  },
}
```

#### image-tag.jsonnet

```jsonnet
local env = std.native('env');
{ tag: env('IMAGE_TAG', 'v0.0.0') }
```

#### ecs-task-def.jsonnet (要点のみ)

```jsonnet
local imageTag = import 'image-tag.jsonnet';
local ssmParams = import 'ssm-params.jsonnet';
{
  family: 'tidb-proxy',
  cpu: '256',
  memory: '512',
  networkMode: 'awsvpc',
  requiresCompatibilities: ['FARGATE'],
  runtimePlatform: {
    cpuArchitecture: 'ARM64',
    operatingSystemFamily: 'LINUX',
  },
  taskRoleArn: ssmParams.ssm.proxy.taskRole,
  executionRoleArn: ssmParams.ssm.proxy.taskExecRole,
  containerDefinitions: [
    {
      name: 'tidb-proxy',
      image: ssmParams.ssm.proxy.ecrRepositoryUri + ':' + imageTag.tag,
      essential: true,
      secrets: [
        // Tailscale auth key は SSM から runtime fetch
        { name: 'TS_AUTHKEY', valueFrom: '/shared/shuntaka/tailscale/proxy-auth-key' },
      ],
      environment: [
        { name: 'TIDB_HOSTNAME', value: 'tidb' },
      ],
      healthCheck: {
        command: [
          'CMD-SHELL',
          "tailscale status --json | jq -e '.BackendState==\"Running\"' >/dev/null && nc -z localhost 13306 && nc -z localhost 3128",
        ],
        interval: 30,
        timeout: 5,
        retries: 3,
        startPeriod: 60,
      },
      logConfiguration: {
        logDriver: 'awslogs',
        options: {
          'awslogs-group': ssmParams.ssm.proxy.logGroupName,
          'awslogs-region': 'ap-northeast-1',
          'awslogs-stream-prefix': ssmParams.serviceName,
        },
      },
    },
  ],
}
```

#### ecs-service-def.jsonnet (要点)

```jsonnet
local ssmParams = import 'ssm-params.jsonnet';
{
  desiredCount: 1,
  launchType: 'FARGATE',
  capacityProviderStrategy: [
    { capacityProvider: 'FARGATE_SPOT', weight: 1 },
  ],
  networkConfiguration: {
    awsvpcConfiguration: {
      assignPublicIp: 'ENABLED',
      securityGroups: [ssmParams.ssm.proxy.sgId],
      subnets: [ssmParams.ssm.vpc.publicSubnetId1],
    },
  },
  serviceRegistries: [
    // Cloud Map registration はここに書く（または service def に直接書かず CDK で作って ARN を SSM 経由で渡す）
  ],
  deploymentConfiguration: {
    deploymentCircuitBreaker: { enable: true, rollback: true },
    maximumPercent: 200,
    minimumHealthyPercent: 0,
  },
  deploymentController: { type: 'ECS' },
  schedulingStrategy: 'REPLICA',
}
```

### デプロイフロー

```
1. CDK で infra 作成 (初回のみ、変更時のみ)
   bunx cdk deploy TidbProxyStack

2. Docker image build + ECR push (image 更新時)
   IMAGE_TAG=$(git rev-parse --short HEAD)
   docker build -t tidb-proxy:$IMAGE_TAG apps/tidb-proxy/
   docker tag tidb-proxy:$IMAGE_TAG ${ECR_URI}:$IMAGE_TAG
   docker push ${ECR_URI}:$IMAGE_TAG

3. ecspresso で task def 更新 + service rolling deploy
   cd iac/aws/ecspresso/tidb-proxy
   IMAGE_TAG=<sha> ecspresso deploy --config ecspresso.jsonnet
```

ECR には lifecycle で 1 image しか残らないので、ストレージ費もほぼゼロ。

### dev / prd 共用なので環境別の deploy 切替は不要

proxy は 1 個しかないので、CDK stack も ecspresso 設定も **1 セット**。dev / prd 別に出し分ける必要なし。

## セキュリティ設計

### Network Boundary (per env)

```
lambda-sg-<env>:
  inbound:  なし（Lambda は外部から直接呼ばれない）
  outbound: tidb-proxy-sg-<env> : 13306 (MySQL)
            tidb-proxy-sg-<env> : 3128  (HTTP forward proxy)

tidb-proxy-sg-<env>:
  inbound:  lambda-sg-<env> : 13306
            lambda-sg-<env> : 3128
  outbound: 0.0.0.0/0 : 443  (Tailscale control plane, 必要な外部 API)
            0.0.0.0/0 : UDP (Tailscale WireGuard direct connection)
```

dev / prd は SG レベルで完全に分離。Lambda は `tidb-proxy-sg-<env>` 以外への egress を持たない。

### squid の egress 制限

```
acl SSL_ports port 443
acl CONNECT method CONNECT

http_access allow localnet CONNECT SSL_ports
http_access deny all
```

destination FQDN の whitelist は持たず、VPC 内 (localnet) からの CONNECT 443 のみを通す方針。理由:

- proxy は VPC 外公開していない (private DNS `tidb-proxy.internal`)。攻撃者が CONNECT を発行するには、まず VPC 内 Lambda のコードを乗っ取る必要がある
- markdown 描画で OGP / link-card / GitHub blob embed のために任意のユーザー指定 FQDN へ HTTPS が必要 (`apps/blog-api/markdown` の `fetch_ogp_html` / `fetch_github_code`)。whitelist 方式だと記事追加のたびに ACL 更新が要る
- 個人ブログの脅威モデルでは Lambda RCE → C2 や悪性 crate の phone-home の影響度が低い (盗まれる secret は GH App PEM のみ)

将来 SSRF を厳しく管理したい場合は、whitelist 復活ではなく **記事 HTML を webhook 受信時に DB へ pre-render** して runtime の外部 fetch を消す方向 (task 文書の改善メモ参照)。

### Tailscale Auth Key

proxy は常駐 1 個（dev/prd 共用）なので **non-ephemeral / reusable / tagged** で発行:

```json
{
  "capabilities": {
    "devices": {
      "create": {
        "reusable": true,
        "ephemeral": false,
        "preauthorized": true,
        "tags": ["tag:proxy"]
      }
    }
  },
  "expirySeconds": 7776000
}
```

90 日で expire するので、Tailscale admin console から再発行 → SSM Parameter Store `/shared/shuntaka/tailscale/proxy-auth-key` を更新 → Fargate task 再起動 (ecspresso deploy)、で運用ローテーション。

### Tailscale ACL の更新

`tag:proxy` から TiDB (`tag:k8s` 想定) への ACL を 1 ルールで許可。`tag:aws-app` の旧 ACL は廃止（Lambda が Tailnet から消えるため）。dev/prd 分離は **TiDB のユーザー権限**（`blog_dev` / `blog_prd` ユーザーで database 権限を分離）で担保。

### Lambda が必要とするシークレットの扱い

Lambda は PRIVATE_ISOLATED subnet にいて NAT/VPC Endpoint を持たないので、AWS SDK の SSM 呼び出しが squid 経由になる。これを避けて運用を単純化するため、**シークレットは deploy-time に CDK が SSM から解決して Lambda の環境変数に焼き込む**:

```typescript
const ghAppSecret = ssm.StringParameter.valueForStringParameter(
  this,
  `/${stage}/shuntaka/github-app/private-key`,
);

new lambda.Function(this, 'BlogApi', {
  environment: {
    GH_APP_SECRET_PEM: ghAppSecret, // 平文 env (KMS で at-rest 暗号化される)
    // ...
  },
});
```

トレードオフ:

- ✅ Lambda runtime に AWS API を一切呼ばないので proxy 依存度が下がる
- ✅ VPC Endpoint コスト ($7〜14/月) が不要
- ✅ cold start も早くなる（SSM API ラウンドトリップが消える）
- ⚠ シークレット rotation 時に CDK redeploy が必要（個人ブログ用途では許容）

## 「device 増殖」への対処

Fargate Spot 中断のたびに Fargate task が再起動 → tsnet が新規 device として登録され、古い device が non-ephemeral なので Tailscale 側で自動削除されない、という現象は起きる。**ただし発生ペースが極めて低い**ので、自動化はせず手動運用で十分。

### 想定される蓄積ペース

| 項目                                     | 数値         |
| ---------------------------------------- | ------------ |
| Fargate Spot 中断頻度（steady workload） | 月 1〜4 回   |
| 1 中断あたり増える proxy device          | 1 個         |
| Personal の tagged resources cap         | 50           |
| **限界到達まで**                         | **5〜10 年** |

### 運用方針

1. **移行完了時に survey の curl one-liner を 1 回走らせて `blog-api-lambda-*` device を全削除**（task 7 後、tsnet-launcher を撤去するので二度と再発しない）
2. その後の `tag:proxy` stale device は **admin console を覗いたタイミングで手動削除**（年 1 回程度のメンテで十分）

EFS で state 永続化する案も、cleanup Lambda 常駐運用案も、**月 1〜4 個の device 蓄積に対しては過剰**なので採用しない。

## タスク分解

### タスク 0: proxy dataplane PoC (Critical)

**理由**: Tailscale userspace networking は SOCKS5/HTTP proxy 経由でしかトラフィックを通せず、素の socat では Tailnet に到達できない（レビュー指摘）。tsnet-launcher の Go コードを Fargate 側に持っていく方針が一番確実だが、想定通り動くかを最初に検証する。

#### 設計

- 既存 `apps/blog-api/tsnet-launcher/main.go` をベースに、Rust server を子プロセスとして起動する部分を削った最小版を作成
- ローカル Docker で起動し、Tailscale auth key を渡して dev tailnet に join、`tidb.<tailnet>:4000` への TCP forward を検証
- 同じコンテナで squid も並走し、CONNECT 経由で `api.github.com:443` に到達できることを確認

#### 事前準備 (依頼者側で実施)

PoC コンテナはローカル `docker run` を前提とするので、AWS SSM は通さず **環境変数で直接** 値を渡す。次の 2 つを発行・控えて、依頼者（このタスクを走らせる人）が用意する。

##### 1. Tailscale ACL に `tag:proxy` を登録

admin console → Access controls で `tagOwners` に `"tag:proxy": ["autogroup:admin"]` を追加して Save。続けて、PoC 疎通用に下記 acls を 1 行追記:

```json
{ "action": "accept", "src": ["tag:proxy"], "dst": ["tag:k8s:4000"] }
```

未登録のまま auth key 発行を試みるとタグ選択肢に出てこないので必須。

##### 2. auth key 発行 (admin console)

<https://login.tailscale.com/admin/settings/keys> → **Generate auth key…** で以下を選ぶ:

| 項目         | 値                      |
| ------------ | ----------------------- |
| Description  | `tidb-proxy PoC`        |
| Reusable     | ✅ ON                   |
| Ephemeral    | ❌ **OFF** (絶対に OFF) |
| Pre-approved | ✅ ON                   |
| Tags         | `tag:proxy`             |
| Expiration   | 90 days                 |

`tskey-auth-...` が 1 回だけ表示されるのでコピー。

##### 3. TAILNET_SUFFIX を控える

<https://login.tailscale.com/admin/dns> 上部 **Tailnet name** に出る `tailXXXX.ts.net` を控える。

##### 4. 環境変数として渡す

PoC では SSM Parameter Store に格納せず、`docker run -e` で直接渡す。本番 (タスク 2 以降) では `/shared/shuntaka/tailscale/proxy-auth-key` に置き換わるので、PoC 中に SSM put-parameter する必要は無い。

```bash
cd apps/tidb-proxy
docker build --platform linux/arm64 -t tidb-proxy:poc .

docker run --rm -it \
  -e TS_AUTHKEY='tskey-auth-...' \
  -e TAILNET_SUFFIX='tailXXXX.ts.net' \
  -e TIDB_HOSTNAME='tidb' \
  -e TIDB_PORT='4000' \
  -p 13306:13306 -p 3128:3128 \
  tidb-proxy:poc
```

forwarder が読む env (詳細は `apps/tidb-proxy/cmd/forwarder/main.go`):

| 環境変数              | 必須 | 既定値                 | 用途                                   |
| --------------------- | ---- | ---------------------- | -------------------------------------- |
| `TS_AUTHKEY`          | ✅   | -                      | Tailscale auth key (reusable / tagged) |
| `TAILNET_SUFFIX`      | ✅   | -                      | `tailXXXX.ts.net`                      |
| `TSNET_HOSTNAME`      |      | `tidb-proxy`           | admin console 上の device 表示名       |
| `FORWARD_LISTEN_ADDR` |      | `0.0.0.0:13306`        | MySQL forwarder の listen              |
| `TIDB_HOSTNAME`       |      | `tidb`                 | Tailnet 上の TiDB device hostname      |
| `TIDB_PORT`           |      | `4000`                 | TiDB ポート                            |
| `TSNET_STATE_DIR`     |      | `/var/lib/tsnet-state` | tsnet state 保存パス                   |

#### PoC 動作検証手順

container が起動したら **別ターミナル** で疎通を確認する。`<TS_AUTHKEY>` / `<TAILNET_SUFFIX>` は事前準備で控えた値に置き換える。

##### 1. 期待される起動ログ

```
entrypoint: squid started pid=...
entrypoint: tidb-forwarder started pid=...
... Squid Cache (Version 6.12): Accepting HTTP Socket connections at conn... local=[::]:3128 ...
config loaded: hostname=tidb-proxy listen=0.0.0.0:13306 target=tidb.<TAILNET_SUFFIX>:4000 ...
tsnet up: hostname=tidb-proxy
forwarder: [::]:13306 -> tailnet:tidb.<TAILNET_SUFFIX>:4000
forwarder: pre-warm dial ok
```

`pre-warm dial failed` の場合は ACL の `tag:proxy → tag:k8s:4000` 漏れか、TiDB Operator Proxy peer の MagicDNS 名が `tidb` 以外で登録されている可能性。admin console の Machines を確認。

##### 2. MySQL forwarder 経由で TiDB 接続

```bash
mysql -h 127.0.0.1 -P 13306 -u <user> -p
# プロンプトが出たら
mysql> SELECT VERSION();
mysql> SHOW DATABASES;
```

##### 3. squid forward proxy 経由で外部 HTTPS

```bash
curl -x http://127.0.0.1:3128 https://api.github.com/zen
# 何らかの格言が返れば OK
```

`TCP_DENIED/403` が返るときは src IP が `10.0.0.0/8` の `localnet` ACL に含まれていない (loopback や Pause container 由来) 可能性。

##### 4. admin console で device 確認

<https://login.tailscale.com/admin/machines> で `tidb-proxy` が 1 個・`tag:proxy` 付き・Connected (緑) になっていること。

##### 5. 再起動時の device 挙動を 2 パターン観測

**5-a. state 喪失パターン (= Fargate Spot 中断時の挙動)**

```bash
# container を Ctrl+C で停止 → 同じコマンドで再起動 を 5 回繰り返す
docker run --rm -it \
  -e TS_AUTHKEY='<TS_AUTHKEY>' \
  -e TAILNET_SUFFIX='<TAILNET_SUFFIX>' \
  -p 13306:13306 -p 3128:3128 \
  tidb-proxy:poc
```

admin console に `tidb-proxy`, `tidb-proxy-1`, `tidb-proxy-2`, ... と連番 device が生えるのが正常。これは「device 増殖への対処」セクションが予測している月 1〜4 個ペースの蓄積と同じ挙動で、Personal の tagged resources cap 50 に対して 5〜10 年もつ前提のため許容範囲。

**5-b. state 永続化パターン (= Fargate task が継続稼働している間の挙動)**

```bash
docker volume create tidb-proxy-state

# 同じコマンドを 2 回以上実行する
docker run --rm -it \
  -v tidb-proxy-state:/var/lib/tsnet-state \
  -e TS_AUTHKEY='<TS_AUTHKEY>' \
  -e TAILNET_SUFFIX='<TAILNET_SUFFIX>' \
  -p 13306:13306 -p 3128:3128 \
  tidb-proxy:poc
```

2 回目以降の起動ログで `tsnet running state path /var/lib/tsnet-state/tailscaled.state` の後、AuthKey を使わず既存 state で復帰すること、admin console の `tidb-proxy` の LastSeen のみ更新され `-N` 連番が生えないことを確認。

##### 6. 後片付け

5-a で生えた `tidb-proxy-1`, `tidb-proxy-2`, ... を admin console の各行 `...` → **Delete** で消す。volume も検証用に作っただけなら `docker volume rm tidb-proxy-state` で削除。

#### チェックリスト

- [x] 既存 launcher の TCP forwarder 部分を切り出して `apps/tidb-proxy/cmd/forwarder/main.go` 作成（child process 起動ロジックは削除）
- [x] alpine ベースの Dockerfile 作成（forwarder + squid + ca-certificates）
- [x] Tailscale ACL に `tag:proxy` の tagOwner + `tag:proxy → tag:k8s:4000` の許可を追加
- [x] admin console から reusable / non-ephemeral / `tag:proxy` の auth key を発行し、手元に控える
- [x] ローカル `docker run` で上記 env を渡して dev tailnet に参加、`mysql -h <container-ip> -P 13306` で dev TiDB に接続成功
- [x] 同コンテナの squid 経由で `curl -x http://<container-ip>:3128 https://api.github.com/zen` 成功
- [x] Tailscale admin console に `tag:proxy` 付き `tidb-proxy` device が 1 個出現することを確認
- [x] **state 喪失パターン**: `docker run --rm` で再起動 5 回 → `tidb-proxy-1`, `tidb-proxy-2`... と連番 device が生えることを確認（= Fargate Spot 中断時の挙動と同じ。月 1〜4 個ペースで増える前提の許容範囲）
- [x] **state 永続化パターン**: `docker volume` を `/var/lib/tsnet-state` にマウントして再起動 5 回 → 同一 `tidb-proxy` device の LastSeen が更新されるだけで連番が生えないことを確認
- [ ] 検証で生えた `tidb-proxy-N` device を admin console から手動削除して片付け

### タスク 1: CDK で infra スキャフォールド構築

#### 設計

CDK は **インフラの土台のみ** を作る。Task definition / Service の挙動は ecspresso 側で管理する。

作るもの (`iac/aws/lib/proxy/tidb-proxy-construct.ts`):

- VPC（既存があれば再利用、無ければ最小 1AZ: public subnet 1 + private subnet 1）
- ECS Cluster `tidb-proxy`
- ECR Repository `tidb-proxy`（lifecycle: 最新 1 image のみ保持）
- IAM TaskRole（SSM secrets 読み取り、ECS UpdateTaskProtection 等）
- IAM ExecutionRole（ECR pull / Logs write、SSM secrets fetch）
- CloudWatch Log Group `/ecs/tidb-proxy` (3 ヶ月保持)
- Security Group `tidb-proxy-sg`（前述の Network Boundary 通り）
- Cloud Map private namespace `internal` + service `tidb-proxy` (TTL 10 sec)
- SSM Parameters で上記の各 ARN / ID / Name を export

⚠ ここでは **Task Definition と ECS Service は作らない**。それらは ecspresso 側の責任。

#### チェックリスト

- [x] `iac/aws/lib/proxy/proxy-vpc-construct.ts` 作成 (VPC + subnets + IGW)
- [x] `iac/aws/lib/proxy/tidb-proxy-construct.ts` 作成 (Cluster + ECR + IAM + LogGroup + SG + CloudMap + SSM Params)
- [x] ECR lifecycle policy `maxImageCount: 1` を設定
- [x] CDK stack に組み込み、`vitest run` で snapshot 確認 (`iac/aws/test/proxy.test.ts.snap`)
- [ ] CDK deploy 実行、SSM Parameter Store に必要な値が出力されていることを確認
- [ ] Tailscale auth key を SSM `/shared/shuntaka/tailscale/proxy-auth-key` に手動で格納（90 日 rotation 運用、手順は `docs/source/01_開発ドキュメント/01_development.md` を参照）

### タスク 2: ecspresso 設定ファイル作成 + 初回 deploy

#### 設計

ファイル配置:

```
iac/aws/ecspresso/tidb-proxy/
├── ecspresso.jsonnet
├── ecs-task-def.jsonnet
├── ecs-service-def.jsonnet
├── ssm-params.jsonnet
└── image-tag.jsonnet
```

すべて `ssm-params.jsonnet` 経由で CDK が出力した SSM Parameter を参照するので、CDK 側で値が変わっても ecspresso 側を書き換えなくて済む。

image-tag.jsonnet は `IMAGE_TAG` 環境変数から読む。CI/CD では git SHA を渡す想定。

`ecspresso.jsonnet` 本体には `{{ ssm }}` テンプレート関数を使えない（task def / service def の前段で評価されるため）。`cluster` と `service` フィールドは `tidb-proxy` をリテラルで持つ。

ECS Service の `enableExecuteCommand: true` を活かすため、`tidb-proxy-task` ロールに `ssmmessages:CreateControlChannel` / `CreateDataChannel` / `OpenControlChannel` / `OpenDataChannel` を付与する。ECS Exec の managed agent が SSM Session Manager との control channel を張るために必要。

#### Fargate awsvpc での内部疎通検証

VPC 内別ホスト（Lambda 等）がまだ無い段階での dataplane 検証は ECS Exec で proxy task 自体に入って行う。

```bash
TASK_ARN=$(aws ecs list-tasks --cluster tidb-proxy --service-name tidb-proxy --query "taskArns[0]" --output text)
aws ecs execute-command --cluster tidb-proxy --task "$TASK_ARN" --container tidb-proxy --command "/bin/sh" --interactive
```

container 内で必要パッケージを入れる（image は alpine + 最小構成）。

```sh
apk add --no-cache curl mysql-client
```

forwarder (`localhost:13306`) は同 container の loopback で動くのでそのまま叩ける。

```sh
mysql -h localhost -P 13306 -u <user> -p <database> -e "SELECT VERSION();"
```

squid (`localhost:3128`) は `squid.conf` の `localnet` ACL に 127.0.0.0/8 を含めていないので localhost からは 403 になる。VPC CIDR (10.0.0.0/8) 内 src でないと CONNECT が allow されない。Fargate awsvpc では `eth0` が link-local (169.254.x.x) の Pause container 用 IF、本物の VPC ENI は別 IF なので、IP は default route から取る。

```sh
EXT_IP=$(ip -4 route get 1.1.1.1 | awk '{print $7; exit}')
curl -sS -x "http://${EXT_IP}:3128" https://api.github.com/zen
```

Lambda 側からの実利用 (タスク 4 以降) は private subnet の VPC IP (10.50.1.x) が src になるので、ACL を変えずに通る。

#### チェックリスト

- [x] `iac/aws/ecspresso/tidb-proxy/` 配下に 5 ファイル作成（IaC 構成セクション参照）
- [x] 初回 image を build & push (`IMAGE_TAG=$(git rev-parse --short HEAD)`)
- [x] `ecspresso deploy --config ecspresso.jsonnet` で初回 task 起動
- [x] Fargate task が Tailnet に join できることを admin console で確認
- [x] ECS Exec で proxy container に入って `mysql -h localhost -P 13306` で TiDB 接続成功
- [x] 同 container から `curl -x http://${EXT_IP}:3128 https://api.github.com/zen` で CONNECT 200 + TLS handshake 成功
- [ ] ECR lifecycle が効いて、複数回 push しても最新 1 image のみ残ることを確認

### タスク 3: image 更新フローを Makefile / scripts に整備

#### 設計

開発者が「アプリ更新 → image push → ecspresso deploy」を 1 コマンドで実行できるように `scripts/deploy-tidb-proxy.sh` を置く。`docker buildx build --push` で build + push を 1 ステップにまとめ、その後 `ecspresso deploy` を叩く。

```bash
scripts/deploy-tidb-proxy.sh
```

主要点:

- `IMAGE_TAG` は環境変数で渡せるが、未指定なら git short SHA を自動採用
- `AWS_REGION` も同様（default `ap-northeast-1`）
- `ECR_URI` は SSM Parameter Store (`/tidb-proxy/proxy/ecr-repository-uri`) から実行時取得
- `set -euo pipefail` で異常時は即 abort

将来 GitHub Actions 化する際は同じスクリプトを呼べばよい。

#### チェックリスト

- [x] `scripts/deploy-tidb-proxy.sh` で build + push + ecspresso deploy を 1 コマンド化
- [x] `docs/source/01_開発ドキュメント/01_development.md` に運用手順を反映

### タスク 4: dev Lambda を VPC 化 + HTTPS_PROXY 設定（先に dev で dual-run）

#### 設計

- 修正: `iac/aws/lib/api/blog-api-construct.ts`
  - Lambda function に `vpc`, `vpcSubnets: { subnetType: PRIVATE_ISOLATED }`, `securityGroups: [lambdaSgDev]` を追加
  - 環境変数 (dev stage):
    - `DATABASE_URL=mysql://blog_dev:${BLOG_DEV_PASSWORD}@tidb-proxy.internal:13306/blog_dev?ssl-mode=PREFERRED`（`${BLOG_DEV_PASSWORD}` は SSM `/dev/shuntaka/tidb/blog-dev-password` から deploy-time に解決して URL に展開）
    - `HTTPS_PROXY=http://tidb-proxy.internal:3128`
    - `HTTP_PROXY=http://tidb-proxy.internal:3128`
    - `NO_PROXY=169.254.169.254,localhost,127.0.0.1`
  - シークレット系は deploy-time SSM 解決で env に焼き込み (`GH_APP_SECRET_PEM`, `GH_WEBHOOK_SECRET`, `CLOUDINARY_API_SECRET` 等)
- 既存の `TS_OAUTH_*` / `TSNET_*` 環境変数を削除
- Lambda の IAM role に `AWSLambdaVPCAccessExecutionRole` を追加
- **dual-run**: 旧 tsnet-launcher の image はまだ削除しない（タスク 7 で削除）。env を切り替えるだけ。

#### チェックリスト

- [ ] CDK で dev Lambda の VPC config 追加（共用 VPC の private subnet）
- [ ] SG `lambda-sg-dev` 作成、outbound を `tidb-proxy-sg:13306, 3128` のみに絞る（proxy 側 SG は env で分けない）
- [ ] proxy 側 SG `tidb-proxy-sg` に `lambda-sg-dev` からの inbound 許可を追加
- [ ] 環境変数の入れ替え
- [ ] `bunx cdk diff` で変更内容確認
- [ ] dev で deploy、Webhook 受信 + 外部 API 呼び出しが proxy 経由で動くことを確認
- [ ] sqlx connection pool の retry/reconnect 挙動を確認（proxy 一時停止 → 再開でアプリが復旧することを試験）

### タスク 5: dev で 1 週間の観測 + 安定確認

#### チェックリスト

- [ ] CloudWatch で cold start latency の before/after 比較記録
- [ ] Fargate Spot 中断時の挙動確認（手動で task 停止して再起動を観察）。Cloud Map の DNS 切り替わり時間と Lambda の DNS cache 挙動を確認
- [ ] cleanup Lambda が stale proxy device (`tag:proxy`) を削除していることを確認
- [ ] squid のアクセスログを覗いて、想定外の destination への CONNECT 試行がないかを確認
- [ ] 1 週間以上の安定運用で大きな問題が無いことを確認

### タスク 6: prd Lambda を共用 proxy 経由に切り替え

#### 設計

dev で動いた構成を prd stage にも展開。**proxy は既に動いている共用 1 個を使い回す**ので、追加 infra は不要。Lambda の env と SG だけ env 別に作る。

- prd Lambda 用 SG `lambda-sg-prd` を新規作成
- proxy 側 SG `tidb-proxy-sg` の inbound に `lambda-sg-prd` を追加
- prd Lambda の VPC config 追加
- prd Lambda の env を proxy 経由に変更:
  - `DATABASE_URL=mysql://blog_prd:${BLOG_PRD_PASSWORD}@tidb-proxy.internal:13306/blog_prd?ssl-mode=PREFERRED`（`${BLOG_PRD_PASSWORD}` は SSM `/prd/shuntaka/tidb/blog-prd-password` から deploy-time に解決して URL に展開）
  - `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` は dev と同じ

TiDB 側でも `blog_prd` ユーザーが作成されていることを確認（dev/prd の権限分離）。

#### チェックリスト

- [ ] `lambda-sg-prd` 作成、proxy SG inbound に追加
- [ ] prd Lambda の VPC config 追加 + 環境変数切り替え
- [ ] `bunx cdk synth -c stageName=prd` snapshot 確認
- [ ] prd デプロイ
- [ ] prd Lambda の動作確認（記事取得 / 投稿フロー / webhook 受信）
- [ ] 24 時間観測

### タスク 7: tsnet-launcher 撤去 + Dockerfile slim 化

#### 設計

- 削除対象:
  - `apps/blog-api/tsnet-launcher/` ディレクトリ（残し置きたい場合は `apps/tidb-proxy/` に共通化）
  - `apps/blog-api/Makefile.toml` の dev 用 DATABASE_URL 組み立て (tailscale CLI 依存)
  - `apps/blog-api/Dockerfile` の Go ビルドステージと `/app/tsnet-launcher` ENTRYPOINT
- Dockerfile を Rust binary を直接 ENTRYPOINT にする形に書き換え
- ローカル開発用の DATABASE_URL は別途整備（localhost PostgreSQL or 直接 dev TiDB へ）

#### チェックリスト

- [ ] `tsnet-launcher` ディレクトリ削除（or `tidb-proxy` に共通化）
- [ ] `apps/blog-api/Dockerfile` を Rust binary 直起動に簡素化
- [ ] `apps/blog-api/Makefile.toml` のローカル開発用 DATABASE_URL を更新
- [ ] image size の before/after 比較記録
- [ ] dev / prd の Lambda イメージを slim 版に置き換え

### タスク 8: Tailscale ACL / device 整理

#### 設計

- ACL 更新:
  - `tag:proxy` → `tag:k8s` (TiDB) を許可（dev/prd 共用なので 1 ルール）
  - `tag:aws-app` → 削除（廃止）
- 既存の `blog-api-lambda-*` device を Tailscale admin console から一括削除（survey の curl スクリプト or cleanup Lambda の手動実行）

#### チェックリスト

- [ ] Tailscale admin console の ACL から `tag:aws-app` 関連を削除し `tag:proxy` を追加
- [ ] OAuth client の権限から `tag:aws-app` を削除
- [ ] `blog-api-lambda-*` device を一括削除

## ロールバック計画

切り戻しが必要な場合の手順（**順序が重要**、レビュー指摘を反映）:

1. **Tailscale ACL を旧 ruleset に戻す**（`tag:aws-app` への ingress 許可を復活）
2. **OAuth client の scope に `tag:aws-app` を戻す**
3. `tsnet-launcher` を git revert で復活、`apps/blog-api/Dockerfile` も revert
4. CDK で Lambda の VPC config を外し、環境変数を旧構成 (`TS_OAUTH_*`) に戻す
5. Lambda を再 deploy（image build → push → CDK deploy）
6. 動作確認後、Fargate proxy は `ecspresso scale --tasks 0` で desiredCount を 0 に（task def と CDK 側の cluster / ECR は残す）

切り戻し時間目安: **60 分**（image build 15 分 + CDK deploy + ecspresso scale + 動作確認）

## 未解決の論点

- [ ] Lambda VPC 化による cold start 影響は許容範囲か（Hyperplane ENI で改善されているはずだが実測必要）
- [ ] sqlx connection pool が proxy restart 後の stale connection を適切に reconnect するか（Rust 側の設定要確認）
- [ ] squid のログレベルと保存期間（ECS の awslogs driver で CloudWatch Logs に流す前提）
- [ ] Fargate task の Public IPv4 が固定でないので、Tailscale の DERP 接続性のためにアウトバウンド制限が必要なら別途検討
- [ ] proxy 自体のメトリクス監視: tailscale reconnect, ECS Spot interruption の頻度, DB forward error の alarm を CloudWatch で取るかどうか
- [ ] IPv6-only egress で `tag:proxy-*` task が組めるか（public IPv4 $3.65/月を削れる可能性、ただし Tailscale control plane が IPv6 reachable か要検証）

## 関連リンク

- 調査: [Tailscale + Lambda の ephemeral ノード蓄積](../../97_survey/2026-06-29-tailscale-lambda-ephemeral-pileup/index.md)
- 前提タスク: [DSQL → TiDB 移行](../2026-06-26-dsql-to-tidb-migration/index.md)（本タスクは TiDB 移行完了後の改善）
- Tailscale Pricing v4: <https://tailscale.com/blog/pricing-v4>
- Tailscale ephemeral nodes 仕様: <https://tailscale.com/docs/features/ephemeral-nodes>
- Tailscale userspace networking: <https://tailscale.com/docs/concepts/userspace-networking>
- GitHub webhook redelivery 仕様: <https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries>
