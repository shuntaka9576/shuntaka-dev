# 環境構築

```{toctree}
:maxdepth: 1
:caption: development
```

## 構成

![image](assets/architecture.drawio.png)

## 初回構築

### Vercel

1. [Vercel](https://vercel.com)でGitHubリポジトリをインポート
2. Root Directory: `apps/web` を指定
3. Framework Preset: Next.js（自動検出）
4. Environment Variables に上記の環境変数を設定
   - Production: 本番用の値を設定
   - Preview: プレビュー用の値を設定
5. Deploy

| 設定項目          | 値                  |
| ----------------- | ------------------- |
| Production Branch | `main`              |
| Preview           | `preview`           |
| Root Directory    | `apps/web`          |
| Framework         | Next.js（自動検出） |

| 変数名                              | 用途              | Production                 | Preview                     |
| ----------------------------------- | ----------------- | -------------------------- | --------------------------- |
| `NEXT_PUBLIC_API_URL`               | バックエンドAPI   | `https://api.shuntaka.dev` | `https://api.shuntaka.tech` |
| `NEXT_PUBLIC_SITE_URL`              | サイトURL         | `https://shuntaka.dev`     | `https://shuntaka.tech`     |
| `NEXT_PUBLIC_GOOGLE_TAG_MANAGER_ID` | GTM               | `GTM-XXXXXXX`              | （空）                      |
| `NEXT_PUBLIC_CLARITY_PROJECT_ID`    | Microsoft Clarity | `xxxxxxxxxx`               | （空）                      |

### GitHub App (Webhook)

記事リポジトリへのpushで自動的に記事を更新するためのGitHub App設定。

1. GitHub Settings → Developer settings → GitHub Apps → New GitHub App
2. 設定値:
   - **GitHub App name**: `shuntaka-blog-api`（任意）
   - **Webhook URL**: `https://api-endpoint/webhooks/github`
   - **Webhook secret**: 任意の文字列を生成して設定（後でSSMに登録）
   - **Permissions**:
     - Repository permissions → Contents: Read-only
   - **Subscribe to events**: Push
3. 作成後、App IDを控える
4. Private keyを生成してダウンロード
5. Webhook secretを控える（SSM登録用）

### AWS

SSM Parameter Storeの登録

GitHub App秘密鍵を登録

```bash
export STAGE_NAME=""
aws ssm put-parameter \
  --name "/${STAGE_NAME}/shuntaka/github-app/private-key" \
  --type "SecureString" \
  --value "$(cat path/to/private-key.pem)"
```

GitHub Webhook Secretを登録（署名検証用）

```bash
export STAGE_NAME=""
export WEBHOOK_SECRET=$(openssl rand -hex 32)

aws ssm put-parameter \
  --name "/${STAGE_NAME}/shuntaka/github-webhook/secret" \
  --type "SecureString" \
  --value "${WEBHOOK_SECRET}"

# GitHub App設定画面で同じ値を設定
echo "GitHub Appに設定するSecret: ${WEBHOOK_SECRET}"
```

Cloudinaryの設定（OGP画像生成用）

1. [Cloudinary](https://cloudinary.com/)でアカウント作成
2. Dashboard から Cloud name, API Key, API Secret を取得
3. SSM Parameter Storeに登録

```bash
export STAGE_NAME=""
aws ssm put-parameter \
  --name "/${STAGE_NAME}/shuntaka/cloudinary/api-secret" \
  --type "SecureString" \
  --value "your-api-secret"
```

Tailscale proxy auth key と tailnet suffix を登録（tidb-proxy Fargate task が Tailnet に join + TiDB の Tailnet hostname を解決するため）。proxy auth key は reusable / non-ephemeral / `tag:proxy` 付きで発行する。dev / prd 共用なので `/shared/shuntaka/...` に 1 つだけ格納する。発行手順は `docs/source/tasks/2026-06-29-blog-api-tidb-proxy.md` の「事前準備」を参照。

```bash
export TS_PROXY_AUTHKEY=""  # tskey-auth-... を貼り付け
export TS_TAILNET_SUFFIX=$(tailscale status --json | jq -r '.MagicDNSSuffix')

aws ssm put-parameter \
  --name "/shared/shuntaka/tailscale/proxy-auth-key" \
  --type "SecureString" \
  --value "$TS_PROXY_AUTHKEY" \
  --overwrite

aws ssm put-parameter \
  --name "/shared/shuntaka/tailscale/tailnet-suffix" \
  --type "String" \
  --value "$TS_TAILNET_SUFFIX" \
  --overwrite

unset TS_PROXY_AUTHKEY TS_TAILNET_SUFFIX
```

OIDCプロバイダーの作成。アカウントに1つのみ作成（初回のみ）。

```bash
export STAGE_NAME=""
# stageNameはこのスタックでは使用しないが、getConfig()の実行に必要
bunx dotenv -- cdk deploy \
  -c stageName=${STAGE_NAME} \
  st-oidc-provider \
  --require-approval never
```

GitHub Actions用のデプロイロールの作成

```bash
export STAGE_NAME=""
bunx dotenv -- cdk deploy \
  -c stageName=${STAGE_NAME} \
  ${STAGE_NAME:0:1}-st-deploy-role \
  --require-approval never
```

ホストゾーンの作成

```bash
export STAGE_NAME=""
export CDK_DEFAULT_ACCOUNT=$(aws sts get-caller-identity --query "Account" --output text)
bunx dotenv -- cdk deploy \
  -c stageName=${STAGE_NAME} \
  ${STAGE_NAME:0:1}-st-global-dns \
  --require-approval never
```

Route53にNSレコードを登録

AWSのRoute53からホストゾーンのNSレコードを確認し、ムームードメインのコンソール画面のNSレコードを変更

証明書の作成

```bash
export STAGE_NAME=""
bunx dotenv -- cdk deploy \
  -c stageName=${STAGE_NAME} \
  ${STAGE_NAME:0:1}-st-tokyo-cert \
  --require-approval never

# デプロイ中にAWSコンソール ap-northeast-1 リージョンのACMで、*.shuntaka.techドメインのDNS検証レコードをRoute53に追加
```

GitHub ActionsにEnvironmentを登録

`gh`コマンドで環境変数を設定（実際のシークレットはSSM Parameter Storeに格納）:

> **Note**: Webフロントエンド（Next.js）の環境変数はVercelダッシュボードで設定します。[Vercelセクション](#vercel)を参照してください。

```bash
# 設定値（環境に応じて変更）
export STAGE_NAME=""
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query "Account" --output text)
export GH_APP_ID=123456
export CLOUDINARY_CLOUD_NAME=your-cloud-name
export CLOUDINARY_API_KEY=123456789012345

# GitHub Environmentの作成（初回のみ）
gh api --method PUT repos/shuntaka9576/shuntaka-dev/environments/${STAGE_NAME}

# GitHub Actions 用（CDKデプロイで使用）
gh secret set AWS_ACCOUNT_ID --env ${STAGE_NAME} --body "${AWS_ACCOUNT_ID}"

# Lambda 環境変数用（CDK経由でLambdaに設定）
gh secret set GH_APP_ID --env ${STAGE_NAME} --body "${GH_APP_ID}"
gh variable set GH_APP_SECRET_PEM_KEY_NAME --env ${STAGE_NAME} --body "/${STAGE_NAME}/shuntaka/github-app/private-key"
gh variable set GH_WEBHOOK_SECRET_KEY_NAME --env ${STAGE_NAME} --body "/${STAGE_NAME}/shuntaka/github-webhook/secret"
gh secret set CLOUDINARY_CLOUD_NAME --env ${STAGE_NAME} --body "${CLOUDINARY_CLOUD_NAME}"
gh secret set CLOUDINARY_API_KEY --env ${STAGE_NAME} --body "${CLOUDINARY_API_KEY}"
gh variable set CLOUDINARY_API_SECRET_KEY_NAME --env ${STAGE_NAME} --body "/${STAGE_NAME}/shuntaka/cloudinary/api-secret"
```

usersテーブルにinstallation_idを登録。GitHub Appをリポジトリにインストール後、installation_idを確認して登録。

```sql
-- installation_idの確認方法:
-- GitHub App設定画面 → Install App → インストール済みリポジトリをクリック
-- URLの末尾の数字がinstallation_id (例: /installations/12345678)

UPDATE app.users
SET github_installation_id = 12345678
WHERE name = 'shuntaka';
```

tidb-proxy スタックのデプロイ（dev / prd 共用、初回のみ）。VPC / ECS Cluster / ECR / IAM / LogGroup / SG / Cloud Map / SSM パラメータを作成する。Task Definition と ECS Service は ecspresso 側で扱う。

```bash
export STAGE_NAME=""
# stageName はこのスタックでは使われないが getConfig() の評価に必要
bunx dotenv -- cdk deploy \
  -c stageName=${STAGE_NAME} \
  st-tidb-proxy \
  --require-approval never
```

ecspresso CLI のインストール（tidb-proxy の Task Definition / ECS Service を管理するため、初回のみ）。

```bash
brew install kayac/tap/ecspresso
ecspresso version
```

tidb-proxy コンテナ image の build & push と ecspresso deploy をまとめた `scripts/deploy-tidb-proxy.sh` を実行する。`IMAGE_TAG` は git short SHA が自動で使われる（環境変数で上書き可）。

```bash
scripts/deploy-tidb-proxy.sh
```

tidb-proxy task の動作確認。`runningCount: 1` かつ `events[0]` が `steady state` になり、ログに `Accepting HTTP Socket connections` と `forwarder: pre-warm dial ok` が出れば成功。<https://login.tailscale.com/admin/machines> で `tidb-proxy` device が `tag:proxy` 付きで Connected (緑) になっているかも確認する。

```bash
aws ecs describe-services \
  --cluster tidb-proxy \
  --services tidb-proxy \
  --query "services[0].{Status:status, Running:runningCount, Desired:desiredCount, Events:events[0:3]}"

aws logs tail /ecs/tidb-proxy --follow --since 5m
```

メインスタックのデプロイ

```bash
export STAGE_NAME=""
bunx dotenv -- cdk deploy \
  -c stageName=${STAGE_NAME} \
  ${STAGE_NAME:0:1}-st-main \
  --require-approval never
```

完了したら、VercelとRoute53にAレコードの紐付けをしてください。

DBマイグレーション

```bash
export STAGE_NAME=""
cd tools/dsql-cli

export DSQL_CLUSTER_ENDPOINT=$(aws ssm get-parameter \
  --name "/${STAGE_NAME}/shuntaka/dsql/cluster-endpoint" \
  --query "Parameter.Value" --output text)
bun run convert --input ../../.legacy/dynamo/backup_prd-Article_20251229-083009.jsonl

# 既存のデータを削除する場合
# bun run drop --endpoint postgresql://postgres:postgres@localhost:5433/postgres
bun run migrate --endpoint $DSQL_CLUSTER_ENDPOINT
```

### GitHub App (Utils)

Renovate のワークフロー（`renovate-apm-update.yaml` / `renovate-cargo-update.yaml`）が lockfile 同期コミットを push した際、後続のチェック（CI / zizmor）が再トリガーされるよう、`GITHUB_TOKEN` ではなく App トークンで push するための GitHub App。

1. GitHub Settings → Developer settings → GitHub Apps → New GitHub App
2. 設定値:
   - GitHub App name: `shuntaka-dev-utils`（任意）
   - Webhook: Active のチェックを外す
   - Repository permissions → Contents: Read and write
3. 作成後、App ID を控える
4. Private key を生成してダウンロード
5. `shuntaka9576/shuntaka-dev` にインストール

リポジトリの Variables / Secrets に登録。

```bash
gh variable set SHUNTAKA_DEV_UTILS_APP_ID --body "<App ID>"
gh secret set SHUNTAKA_DEV_UTILS_PRIVATE_KEY < path/to/private-key.pem
```

### ライブラリ更新

依存関係の自動アップデートPRを作成するためのRenovateを利用。以下の設定で導入が可能。

1. https://github.com/apps/renovate にアクセス
2. 「Install」をクリック
3. 対象リポジトリ（shuntaka9576/shuntaka-dev）を選択してインストール
4. リポジトリルートの `renovate.json` が自動で読み込まれる

### GitHub Actions

zizmorをGitHub Code Scanningに連携し、GitHub Actionsのセキュリティリスクに対する静的解析を行っている。[こちら](https://dev.classmethod.jp/articles/shuntaka-zizmor-sarif-code-scanning/)の手順で導入。[gh-infra](.github/infra.yaml)側にも設定あり。

## 開発

### 開発サーバーの起動

```bash
# 依存関係のインストール
bun install

# PostgreSQL起動（全worktreeで共有）
docker compose up -d postgres

# DBマイグレーション（初回のみ）
cd tools/dsql-cli
bun run migrate --endpoint postgresql://postgres:postgres@localhost:5433/postgres
cd ../..

# AWS資格情報の取得が必要
aws-vault exec <プロファイル名>

# dev server起動（Next.js + Rust API + Sphinx）
bun run dev
```

### Agents SKillsの設定

[microsoft/apm](https://github.com/microsoft/apm) で管理。AIコーディングエージェントはClaude Codeを利用するものとする。

初回セットアップ（macOS）

```bash
brew install apm
apm install -t claude
```

取り込み（依存追加・clone 直後・lockfile 更新後）

```bash
apm install -t claude
```

追加

```bash
apm install <owner>/<repo>/skills/<path>/<name> -t claude
```

更新（upstream の最新を取り込み、lockfile を更新）

```bash
apm install --update -t claude
```

削除

```bash
apm uninstall <package> -t claude
```

完全リセット（apm.yml のパス書き換えが反映されないときに使う。apm は `apm_modules/` をローカル展開先として保持し、ここに旧構造のスナップショットが残っていると新パスを書いても `(cached)` 表示でそのまま再利用されるため、apm_modules と lockfile を消してから入れ直す）

```bash
rm -rf apm_modules apm.lock.yaml
apm install -t claude
```

新しい `apm.lock.yaml` の `virtual_path` が apm.yml と同じパスになっていることを確認する。

```bash
grep virtual_path apm.lock.yaml
```

Renovate APM Update PR のマージ前は zizmor を手動トリガーする。`renovate-apm-update.yaml` の lockfile 同期コミットが `[skip ci]` 付きで push されるため、最新コミットの zizmor が走らずブランチ保護でブロックされる（背景は `docs/source/survey/2026-05-27-renovate-apm-update-ci-loop.md`）。

```bash
gh workflow run zizmor.yaml --ref <PRブランチ名>
```

### GitHub設定変更作業

[babarot/gh-infra](https://github.com/babarot/gh-infra)でリポジトリ設定（visibility, labels, features, merge_strategy, security, rulesets, actions）を [`.github/infra.yaml`](.github/infra.yaml) で宣言的に管理。CI連携はせず手動運用。

差分確認

```bash
gh infra plan .github/infra.yaml
```

適用

```bash
gh infra apply .github/infra.yaml --auto-approve
```

GitHub の現状をマニフェストに再取り込み

```bash
gh infra import shuntaka9576/shuntaka-dev > .github/infra.yaml
```

### シークレット漏洩対策

Claude Code 経由のシークレット漏洩を `.claude/settings.json` の env scrub と UserPromptSubmit hook、`lefthook.yaml` の pre-commit (secretlint + gitleaks)、PreToolUse Bash hook (`block-noverify.ts`) による `--no-verify` バイパス拒否の4層で防ぐ。設計の詳細は CLAUDE.md の Security セクション参照。

gitleaks のバイナリインストール（初回のみ）。

```bash
brew install gitleaks
```

### bare clone環境でworktree開発をする場合(任意)

本リポジトリはbare clone + git worktree構成で管理している。worktreeの管理には[Worktrunk](https://worktrunk.dev)を使用する。

```
shuntaka-dev/          # bare clone
├── .bare/             # git bare repository
├── .envrc             # 共通環境変数（秘匿情報等）
├── preview/           # メインworktree（previewブランチ）
├── feature-foo/       # 作業worktree（wt switchで自動作成）
└── fix-bar/           # 作業worktree
```

bare clone環境では`core.hooksPath`が不正なパスを指している場合がある。lefthookがworktreeで動作しない場合は以下を実行する（リポジトリに対して一度だけ）。

```bash
git config --local --unset core.hooksPath
```

previewワークツリーの環境変数は、previewはWorktrunkのpre-startフックの対象外のため、初回のみ手動で`.env.local`と`.envrc`を作成する。

```bash
cat > .env.local <<'EOF'
WEB_PORT=3000
API_PORT=8080
NEXT_PUBLIC_SITE_URL=http://localhost:3000
NEXT_PUBLIC_API_URL=http://localhost:8080
PORT=8080
DOCS_PORT=8000
EOF

cat > .envrc <<'EOF'
source_up
dotenv .env.local
EOF
direnv allow .
```

ポートマッピングに関して、複数worktreeのdev serverを同時に起動できるよう、worktreeごとにポートが自動割り当てされる。`.config/wt.toml`のpre-startフックにより、`wt switch --create`時に`.env.local`と`.envrc`が自動生成される。

| 変数                   | 内容                      | preview（既定）         |
| ---------------------- | ------------------------- | ----------------------- |
| `WEB_PORT`             | Next.js devサーバーポート | 3000                    |
| `API_PORT` / `PORT`    | Rust APIポート            | 8080                    |
| `DOCS_PORT`            | Sphinxドキュメントポート  | 8000                    |
| `NEXT_PUBLIC_SITE_URL` | フロントエンドURL         | `http://localhost:3000` |
| `NEXT_PUBLIC_API_URL`  | API URL                   | `http://localhost:8080` |

新規worktreeではブランチ名から10000-19999の範囲でポートが決定的に生成される。同じブランチ名なら常に同じポートになる。

ブランチ作業は、`wt switch --create`で新しいworktreeを作成する。pre-startフックにより`.env.local`（ポート設定）、`.envrc`、依存関係のインストールが自動で行われる。

```bash
# worktree作成＆切り替え
wt switch --create feature/new-thing

# dev server起動
bun run dev
```

初回のみフック承認が求められるので`y`で承認する。承認は`~/.config/worktrunk/approvals.toml`に保存され、次回以降は自動実行される。

```
▲ shuntaka-dev needs approval to execute 4 commands:
○ pre-start env: ...
○ pre-start envrc: ...
○ pre-start copy: ...
○ pre-start install: ...

❯ Allow and remember? [y/N] y
```

その他の操作。

```bash
# 既存worktreeに切り替え
wt switch preview

# worktree一覧（URLも表示）
wt list

# worktreeの削除
wt remove feature/new-thing

# previewブランチへマージ＆削除
wt merge
```

## 運用コマンド

### psql接続（DSQL）

SSMからエンドポイントを取得してDSQLに接続する方法。

```bash
export STAGE_NAME=""

# SSMからDSQLエンドポイントを取得
HOST=$(aws ssm get-parameter \
  --name "/${STAGE_NAME}/shuntaka/dsql/cluster-endpoint" \
  --query "Parameter.Value" --output text)

# 認証トークンを生成
TOKEN=$(aws dsql generate-db-connect-admin-auth-token \
  --hostname "$HOST" \
  --region ap-northeast-1)

# psqlで接続（トークンをパスワードとして使用）
PGPASSWORD="$TOKEN" psql \
  --dbname postgres \
  --username admin \
  --host "$HOST" \
  --port 5432
```

### dsql-cli

PostgreSQLを起動

```bash
# ルートディレクトリで
docker compose up -d postgres
```

マイグレーション実行

```bash
cd tools/dsql-cli
# ローカル
bun run migrate --endpoint postgresql://postgres:postgres@localhost:5433/postgres

# DSQL
export STAGE_NAME=""
export DSQL_CLUSTER_ENDPOINT=$(aws ssm get-parameter \
  --name "/${STAGE_NAME}/shuntaka/dsql/cluster-endpoint" \
  --query "Parameter.Value" --output text)
bun run migrate --endpoint $DSQL_CLUSTER_ENDPOINT
```

スキーマ削除

```bash
cd tools/dsql-cli
# ローカル
bun run drop --endpoint postgresql://postgres:postgres@localhost:5433/postgres

# DSQL
bun run drop --endpoint $DSQL_CLUSTER_ENDPOINT
```

DynamoDB→DSQLデータ変換

```bash
cd tools/dsql-cli

# 本番データを変換（99_seed_data.sqlを生成）
bun run convert --input ../../.legacy/dynamo/backup_prd-Article_20251229-083009.jsonl

# ローカルDBに投入
bun run drop --endpoint postgresql://postgres:postgres@localhost:5433/postgres
bun run migrate --endpoint postgresql://postgres:postgres@localhost:5433/postgres

# DSQLに投入
bun run drop --endpoint $DSQL_CLUSTER_ENDPOINT
bun run migrate --endpoint $DSQL_CLUSTER_ENDPOINT
```

### tidb-seeder

TiDB の `EXPLAIN ANALYZE` の癖（opt が index vs full scan を cost 差で選び分ける挙動、統計の鮮度による plan 分岐、`total_process_keys_size` の効き方など）を確認する用途で、`users` / `tags` / `articles` / `articles_tags` のダミーデータを PG TEXT 互換 TSV として生成する。生成された TSV は既存の `dsl-tidb/load.sh` でそのまま流し込める。

生成のみ実施 (500 万行、articles 合計 約 33GB、M1 Pro 4 workers / SSD で約 75 秒)

```bash
cd tools/tidb-seeder
bun run generate \
  --out-dir ./out \
  --users 5 \
  --articles-per-user 1000000 \
  --tags 100 \
  --content-size 6000 \
  --workers 4 \
  --no-concat \
  --rows-per-part 15000
```

`--workers N` で articles / articles*tags の生成を N 個の bun 子プロセスに分散する（P-core 数と同じにするのが目安）。`--no-concat` を渡すと最後の cat による結合 (30GB × 2 の追加 I/O = 数分) をスキップし、`app.articles.part<W>*<C>.tsv`/`app.articles*tags.part<W>*<C>.tsv` のままにする。`--rows-per-part 15000`で 1 パートファイルを 15,000 行 (~90MB) ごとにローテートし、TiDB LOAD DATA が`txn-total-size-limit` (100MB) を超えないようにする。load.sh 側で part ファイルを自動検出して部分ごとに LOAD DATA するため、UX は同じ。

生成 → 検証用 DB へロード

Tailnet suffix を取得（Tailscale ログイン済み前提。TiDB の Tailnet ホスト `tidb.<TAILNET>` を解決するのに使う。固有名を直書きせず毎回コマンドで取り出す）

```bash
export TAILNET=$(tailscale status --json | jq -r '.MagicDNSSuffix')
echo "TAILNET=$TAILNET"
```

TiDB への経路が p2p (direct) か確認する。DERP relay 経由だと 33GB の LOAD DATA が数十分〜数時間かかりうるので、direct でないなら NAT / firewall を先に対処する

```bash
tailscale ping tidb.$TAILNET
# OK 例 (direct):
#   pong from tidb (100.x.x.x) via 192.168.x.x:41641 in 3ms
# NG 例 (DERP 経由):
#   pong from tidb (100.x.x.x) via DERP(tok) in 45ms
```

`tailscale ping` は direct が張れた時点で停止する。初回は DERP → direct へ数回で切り替わるのが正常。10 パケット全部 DERP のままなら経路が張れていないので、`tailscale netcheck` で NAT / UDP 到達性を確認する。

TiDB の LOAD DATA LOCAL INFILE は 1 ステートメント = 1 トランザクションで扱われ、`txn-total-size-limit`（デフォルト 100MB）を超えると `ERROR 2013 Lost connection` で落ちる。TiDB v8+ の bulk モードは LOAD DATA には効かない（詳細は [調査メモ](survey/2026-07-01-tidb-load-data-large-file.md)）。そのため seeder に `--rows-per-part 15000` を渡し、1 パートファイルを ~90MB に抑える

TSV 生成 → DB 再作成 → load

```bash
# 1. TSV 生成 (1 ユーザーあたり 100 万記事 × 5 ユーザー = 500 万行 / articles 合計 約 33GB)
cd tools/tidb-seeder
bun run generate --out-dir ./out --users 5 --articles-per-user 1000000 --workers 4 --no-concat --rows-per-part 15000

# 2. 検証用 DB を作り直す (既存がある場合)
mysql -h tidb.$TAILNET -P 4000 -u root \
  -e "DROP DATABASE IF EXISTS blog_test"

# 3. TiDB に並列 LOAD DATA (DDL + parts を parallelism=8 の mysql2 connection で流し込む)
bun run load --host tidb.$TAILNET --database blog_test --tsv-dir ./out --parallelism 8
```

`bun run load` は `dsl-tidb/schema/*.sql` で DDL を張り、`dsl-tidb/load/*.sql` テンプレートを parts ごとに substitute して mysql2 の LOAD DATA LOCAL INFILE をコネクションプール (`--parallelism` 個) で並列実行する。1 コネクション 1 ファイルの sequential mysql CLI (`load.sh`) と違い、8 コネクション同時に叩けるので、300+ パートでも待ち時間が 1/N 程度に縮む。`load.sh` は引き続き dsql-cli 経由の CLI 手順で残しているので、mysql コマンドだけで完結させたい場合はそちらも使える。

500 万行スケールでは articles 合計で約 33GB になる。TiDB 側の region 数増加とローカルディスクの空きを事前に見積もる。scale を下げたい場合は `--articles-per-user 300000` (合計 150 万行 / 約 10GB) や `--articles-per-user 50000` (合計 25 万行 / 約 1.7GB) に落として同じ手順で回す。scale が小さければ `--no-concat` を外して単一ファイルにまとめても速度差は小さい。

同じ `--seed` を渡せば内容は決定的に再現される（default `42`）。`--content-size` は 1 記事あたりの目標バイト数で、paragraph 合成が閾値を超えた時点で打ち切るため実サイズは目標をやや上回る。`--workers 1` にすると子プロセス不使用の直書き single-process 経路に切り替わる。
