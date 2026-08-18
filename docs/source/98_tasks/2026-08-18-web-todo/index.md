# web-todo（認証必須の日次チェックリスト・献立・買い物リスト）

- 起票日: 2026-08-18
- ステータス: 実装完了、本番反映は未実施
- URL: `https://admin.shuntaka.dev/todo`
- 前提基盤: [logs 管理画面のアーキテクチャ](../2026-07-12-logs-admin-architecture/index.md)

## 目的

毎朝の決まった行動を当日分のチェックリストとして生成し、完了状態を記録する。あわせて、直近3日分の朝・昼・夜の献立と、現在必要な買い物を同じ画面で管理する。

チェックリスト本文は個人的な内容を含むため、公開リポジトリへ初期値・fixture・seed として置かない。認証後の設定画面から登録し、TiDB のみに保存する。

## 仕様

画面には常に次の順で3項目を表示する。

1. チェックリスト
2. 直近の献立リスト
3. 買い物リスト

買い物が0件なら `買い物リスト：なし` と表示する。献立の空欄は `未定` として扱う。

### チェックリスト生成

- `/todo/settings` でIANAタイムゾーン、生成時刻、Markdownテンプレートを設定する
- 入力Markdown原文は規約を含めてDBへ保存する。そのうち `# 朝` と `# 寝る前` の箇条書きだけを日次テンプレートへ展開し、インデントを親子関係へ変換する
- EventBridgeがadmin-api Lambdaを5分ごとに起動する
- Lambdaはユーザーごとのローカル日付・時刻を計算し、設定時刻を過ぎていれば当日分を生成する
- `user_id + todo_date + source_template_id` の一意制約と決定的IDにより、EventBridgeのat-least-once実行でも重複しない
- 初回設定時は当日分を即時生成する。テンプレート再編集は翌日の生成分から反映する
- バッチ障害時は `/todo` の「今日の分を生成」で同じ冪等処理を手動実行できる

### 認証・非公開性

- SPA本体にチェックリスト本文は含まれない。静的ファイルが公開されても個人データは取得できない
- `/api/todo` とその配下はすべて既存の`sessionAuth`対象で、Cognitoログインと有効なDBセッションが必要
- すべての読み書きでセッション由来の`user_id`を条件に含め、別ユーザーのIDを指定しても操作できない
- CloudFrontのHostガードにより、管理画面・APIはadminドメイン以外から露出しない
- DB保存は暗号化カラムではなく、既存TiDBのアクセス境界で保護する。DB管理者からも秘匿する要件が生じた場合はアプリケーション層暗号化を別タスクで追加する

## データモデル

| テーブル              | 用途                                                       |
| --------------------- | ---------------------------------------------------------- |
| `todo_settings`       | タイムゾーン、毎朝の生成時刻、規約を含む入力Markdown原文   |
| `todo_template_items` | 朝・寝る前の階層テンプレート。個人的な本文はここだけに保存 |
| `todo_daily_items`    | 日付ごとのスナップショットと完了時刻                       |
| `todo_meals`          | 日付 × 朝昼夜の献立。未定は行を持たない                    |
| `todo_shopping_items` | 現在必要な買い物。同名は正規化して1件にまとめる            |

既存方針に合わせてFKは持たず、ユーザー境界と整合性はAPI層で保証する。

## 実装箇所

- `apps/admin-web`: `/todo`、`/todo/settings`、Markdown階層パーサー
- `apps/admin-api`: 認証必須のtodo API、日次生成処理
- `iac/aws/lib/admin/admin-stack.ts`: 5分間隔のEventBridgeルール
- `tools/dsql-cli/dsl-tidb/schema/12_*.sql`〜`16_*.sql`: TiDB DDL

## 検証

実装時に次を実行済み。

```sh
bun --filter @shuntaka-dev/admin-api type-check
bun --filter @shuntaka-dev/admin-api test
bun --filter @shuntaka-dev/admin-web build
bun --filter @shuntaka-dev/admin-web test
bun --filter @shuntaka-dev/aws type-check
bun --filter @shuntaka-dev/aws test
```

- admin-api: 13 tests passed
- admin-web Markdown parser: 1 test passed
- CDK: 9 tests passed、admin stack snapshot更新済み

## 手動反映手順

DBテーブルが無い状態でadmin stackを先にデプロイすると、5分間隔のバッチが失敗する。**DDL → デプロイ**の順を守る。

### 1. dev DBへDDL適用

mainへマージするとdev CDKが自動デプロイされるため、マージ前に実施する。

```sh
export TAILNET=$(tailscale status --json | jq -r '.MagicDNSSuffix')
cd tools/dsql-cli/dsl-tidb

for file in schema/12_todo_settings.sql \
  schema/13_todo_template_items.sql \
  schema/14_todo_daily_items.sql \
  schema/15_todo_meals.sql \
  schema/16_todo_shopping_items.sql; do
  sed 's|${SCHEMA}|blog_dev|g' "$file"
done | mysql -h "tidb.${TAILNET}" -P 4000 -u root -p

mysql -h "tidb.${TAILNET}" -P 4000 -u root -p -D blog_dev \
  -e "SHOW TABLES LIKE 'todo_%';"
```

5テーブルが表示されることを確認する。DDLは`CREATE TABLE IF NOT EXISTS`だけなので再実行でき、既存テーブルへの変更はない。

### 2. devデプロイ・動作確認

PRをmainへマージするか、マージ前に手動workflowで検証する。

```sh
gh workflow run deploy.yaml --ref <branch> -f stageName=dev -f stack=admin
gh run list --workflow=deploy.yaml --limit 1
```

デプロイ後に次を確認する。

```sh
# APIは未認証で必ず401
curl -s -o /dev/null -w '%{http_code}\n' https://admin.shuntaka.tech/api/todo

# EventBridgeルールが有効
aws events describe-rule --name d-st-todo-generation \
  --query '{State:State,ScheduleExpression:ScheduleExpression}'
```

ブラウザで`https://admin.shuntaka.tech/todo`へログインし、次を確認する。

1. `/todo/settings`へユーザー保有のチェックリストMarkdownを貼り付ける。本書やGit管理ファイルへ本文を転記しない
2. 初回保存直後に当日分が生成される
3. 子項目の階層、チェックON/OFF、献立の保存・未定への戻し、買い物の同名集約・除外が動く
4. 設定した時刻の次の5分境界以降に、翌日分が1回だけ生成される

DB側の確認は本文を端末へ表示しない集計だけにする。

```sh
mysql -h "tidb.${TAILNET}" -P 4000 -u root -p -D blog_dev -e '
SELECT todo_date, period, COUNT(*) AS items, COUNT(completed_at) AS completed
FROM todo_daily_items
GROUP BY todo_date, period
ORDER BY todo_date DESC, period;'
```

### ローカルプレビュー

ローカルではCognitoログインを省略できる。`.env.local`へ次を追加する。

```sh
DEV_AUTH_BYPASS=1
DEV_INSECURE_COOKIES=1
```

バイパスは、両方のフラグが有効、リクエスト先が`localhost`または`127.0.0.1`、AWS Lambda環境ではない、という全条件を満たす場合だけ有効になる。単一ユーザー運用のため`blog_dev.users`の先頭ユーザーを利用する。`blog_dev`へのDDL適用後、別ターミナルで起動する。

```sh
bun --filter @shuntaka-dev/admin-api dev
bun --filter @shuntaka-dev/admin-web dev
```

現在のworktreeのURLは`bun run port`で確認し、表示されたadmin-web URLの`/todo`を開く。main worktreeの既定は`http://localhost:43002/todo`。

### 3. 本番バックアップ

本番DDL適用前にリポジトリルートで実行する。

```sh
bun run dump:prd
```

`backup/blog_prd-<timestamp>.sql`が作成され、スクリプト末尾の検証が成功したことを確認する。バックアップはgitignore対象であり、コミットしない。

### 4. blog_prdへDDL適用

tagprリリースPRをマージする前に実施する。

```sh
export TAILNET=$(tailscale status --json | jq -r '.MagicDNSSuffix')
cd tools/dsql-cli/dsl-tidb

for file in schema/12_todo_settings.sql \
  schema/13_todo_template_items.sql \
  schema/14_todo_daily_items.sql \
  schema/15_todo_meals.sql \
  schema/16_todo_shopping_items.sql; do
  sed 's|${SCHEMA}|blog_prd|g' "$file"
done | mysql -h "tidb.${TAILNET}" -P 4000 -u root -p

mysql -h "tidb.${TAILNET}" -P 4000 -u root -p -D blog_prd \
  -e "SHOW TABLES LIKE 'todo_%';"
```

### 5. tagprリリースPRを人間がマージ

mainマージ後にtagprが作成・追従する、`tagpr`ラベル付きリリースPRを人間がマージする。手動タグは作らない。

マージによりCalVerタグ作成後、`tagpr.yaml`の`deploy-prd`がprd CDKを実行し、`p-st-admin`へ次が反映される。

- `/todo`入りadmin-web SPA
- todo API・バッチ処理入りadmin-api Lambda
- `p-st-todo-generation` EventBridgeルール

```sh
gh run list --workflow=tagpr.yaml --limit 1
```

`Deploy prd (CDK)`が成功してから次へ進む。

### 6. 本番の初期設定と確認

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://admin.shuntaka.dev/api/todo
aws events describe-rule --name p-st-todo-generation \
  --query '{State:State,ScheduleExpression:ScheduleExpression}'
```

- 未認証APIが`401`
- EventBridgeが`ENABLED`、`rate(5 minutes)`
- `https://admin.shuntaka.dev/todo`がログイン後に表示される

本番の`/todo/settings`へチェックリストMarkdownを貼り付けて保存する。dev DBから本文をSQLダンプで移さず、認証画面から明示的に登録する。登録後は本文を表示しない集計クエリで件数だけ確認する。

```sh
mysql -h "tidb.${TAILNET}" -P 4000 -u root -p -D blog_prd -e '
SELECT period, COUNT(*) AS templates
FROM todo_template_items
GROUP BY period;
SELECT todo_date, period, COUNT(*) AS items
FROM todo_daily_items
GROUP BY todo_date, period
ORDER BY todo_date DESC, period;'
```

## 切り戻し

不具合時はまずEventBridgeルールを止める。チェック状態・献立・買い物データは削除しない。

```sh
aws events disable-rule --name p-st-todo-generation
```

直前の正常なCalVerタグを指定してDeploy workflowの`stageName=prd`、`stack=admin`を手動実行し、admin stackだけを戻す。テーブルは後方互換な追加のみなので残置する。完全削除が必要になった場合も、先に本番ダンプを取得し、ユーザー確認後に別作業として実施する。

## スコープ外

- チャット本文をAIが解析して献立・買い物へ自動反映する機能
- DB管理者からも本文を秘匿するアプリケーション層暗号化
- 複数ユーザー間の共有・権限委譲
- 通知、リマインダー、連続達成日数などの分析

## 実施ログ

- 2026-08-18: `blog_dev`へtodo用5テーブルをDDL適用。`SHOW TABLES LIKE 'todo_%'`で全テーブルを確認
- 2026-08-18: ローカル認証バイパスを追加。ルート`.env.local`をadmin-apiが直接読むようにし、`/api/me`と`/api/todo`が200になることを確認
- 2026-08-18: Playwrightで`http://localhost:43002/todo`を確認。ログイン画面へ遷移せず、チェックリスト・直近の献立・買い物リストの3セクションが表示された
