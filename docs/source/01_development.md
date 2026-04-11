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

| 変数名                              | 用途            | Production                 | Preview                     |
| ----------------------------------- | --------------- | -------------------------- | --------------------------- |
| `NEXT_PUBLIC_API_URL`               | バックエンドAPI | `https://api.shuntaka.dev` | `https://api.shuntaka.tech` |
| `NEXT_PUBLIC_SITE_URL`              | サイトURL       | `https://shuntaka.dev`     | `https://shuntaka.tech`     |
| `NEXT_PUBLIC_GOOGLE_TAG_MANAGER_ID` | GTM             | `GTM-XXXXXXX`              | （空）                      |

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

#### SSM Parameter Storeの登録

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

#### OIDCプロバイダーの作成

アカウントに1つのみ作成（初回のみ）。

```bash
export STAGE_NAME=""
# stageNameはこのスタックでは使用しないが、getConfig()の実行に必要
bunx dotenv -- cdk deploy \
  -c stageName=${STAGE_NAME} \
  st-oidc-provider \
  --require-approval never
```

#### GitHub Actions用のデプロイロールの作成

```bash
export STAGE_NAME=""
bunx dotenv -- cdk deploy \
  -c stageName=${STAGE_NAME} \
  ${STAGE_NAME:0:1}-st-deploy-role \
  --require-approval never
```

#### ホストゾーンの作成

```bash
export STAGE_NAME=""
export CDK_DEFAULT_ACCOUNT=$(aws sts get-caller-identity --query "Account" --output text)
bunx dotenv -- cdk deploy \
  -c stageName=${STAGE_NAME} \
  ${STAGE_NAME:0:1}-st-global-dns \
  --require-approval never
```

#### Route53にNSレコードを登録

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

#### GitHu ActionsにEnvironmentを登録

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

#### メインスタックのデプロイ

```bash
export STAGE_NAME=""
bunx dotenv -- cdk deploy \
  -c stageName=${STAGE_NAME} \
  ${STAGE_NAME:0:1}-st-main \
  --require-approval never
```

完了したら、VercelとRoute53にAレコードの紐付けをしてください。

#### DBマイグレーション

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

### Renovate

依存関係の自動アップデートPRを作成するためのRenovate設定。

1. https://github.com/apps/renovate にアクセス
2. 「Install」をクリック
3. 対象リポジトリ（shuntaka9576/shuntaka-dev）を選択してインストール
4. リポジトリルートの `renovate.json` が自動で読み込まれる

## ローカル開発

本リポジトリはbare clone + git worktree構成で管理している。worktreeの管理には[Worktrunk](https://worktrunk.dev)を使用する。

```
shuntaka-dev/          # bare clone
├── .bare/             # git bare repository
├── .envrc             # 共通環境変数（秘匿情報等）
├── preview/           # メインworktree（previewブランチ）
├── feature-foo/       # 作業worktree（wt switchで自動作成）
└── fix-bar/           # 作業worktree
```

### 初回セットアップ

#### lefthook

bare clone環境では`core.hooksPath`が不正なパスを指している場合がある。lefthookがworktreeで動作しない場合は以下を実行する（リポジトリに対して一度だけ）。

```bash
git config --local --unset core.hooksPath
```

#### previewワークツリーの環境変数

previewはWorktrunkのpre-startフックの対象外のため、初回のみ手動で`.env.local`と`.envrc`を作成する。

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

# dev server起動（Next.js + Rust API + Sphinx）
bun run dev
```

### ブランチ作業

`wt switch --create`で新しいworktreeを作成する。pre-startフックにより`.env.local`（ポート設定）、`.envrc`、依存関係のインストールが自動で行われる。

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

### ポートマッピング

複数worktreeのdev serverを同時に起動できるよう、worktreeごとにポートが自動割り当てされる。`.config/wt.toml`のpre-startフックにより、`wt switch --create`時に`.env.local`と`.envrc`が自動生成される。

| 変数                   | 内容                      | preview（既定）         |
| ---------------------- | ------------------------- | ----------------------- |
| `WEB_PORT`             | Next.js devサーバーポート | 3000                    |
| `API_PORT` / `PORT`    | Rust APIポート            | 8080                    |
| `DOCS_PORT`            | Sphinxドキュメントポート  | 8000                    |
| `NEXT_PUBLIC_SITE_URL` | フロントエンドURL         | `http://localhost:3000` |
| `NEXT_PUBLIC_API_URL`  | API URL                   | `http://localhost:8080` |

新規worktreeではブランチ名から10000-19999の範囲でポートが決定的に生成される。同じブランチ名なら常に同じポートになる。

## ツール

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
