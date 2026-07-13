# GitHub webhook の非同期化（自己 Event invoke で 10 秒配信タイムアウトを回避）

- 起票日: 2026-07-13
- 関連: [PR #625](https://github.com/shuntaka9576/shuntaka-dev/pull/625) / [content_html 事前生成](../2026-07-02-articles-content-html-pregeneration/index.md) / [blog-api の VPC + Fargate Proxy 構成](../2026-06-29-blog-api-tidb-proxy/index.md)
- ステータス: 実装済み（dev で E2E 検証完了、本番リリース待ち）

## 起票理由

article リポジトリへの push 後、GitHub App (shuntaka-blog-api) の Recent Deliveries が 2026-07-11 以降すべて「timed out」で失敗表示になっていた。CloudWatch Logs で webhook 受信〜処理完了の所要時間を遡ると、記事数の増加とともに処理時間が線形に伸び、7/11 にちょうど GitHub の webhook 配信タイムアウト（**固定 10 秒、延長不可**）を超えたことが分かった。

| 日時 (JST)           | 処理時間  | GitHub 側の結果 |
| -------------------- | --------- | --------------- |
| 06-30 / 07-01        | 3 秒      | 成功            |
| 07-05                | 6 秒      | 成功            |
| 07-11 10:24〜（5回） | 9〜11 秒  | ここから全滅    |
| 07-11 18:58          | 16 秒     | 失敗            |
| 07-13（4回）         | 15〜23 秒 | 失敗            |

処理自体は毎回完走していた（Lambda タイムアウトは 15 分）ため、実害は「GitHub 上の失敗表示」と「GitHub API の一時的な 502 でファイル取得が数件落ちた場合に再配信が必要」の 2 点。ただし全 112 記事のフルスキャン（GitHub Contents API から全ファイル取得 + 記事ごとに DB SELECT 2 回 × Lambda→tidb-proxy→Tailnet→TiDB の往復 30〜40ms ≒ 9 秒）が push のたびに走る構造のため、放置すると悪化し続ける。

調査時に、fetch 失敗のエラーログが `slug=unknown` でどのファイルが落ちたのか特定できない問題も見つけた（あわせて修正）。

## 設計方針

| 論点                    | 決定                                                                                                                                                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 非同期化の方式          | 自分自身への Lambda Event invoke。受付ハンドラーは署名検証 + push/ブランチ判定のみで即 200 を返す。素の Lambda は「レスポンスを返してから処理を続ける」ことができない（返した時点で実行環境がフリーズ）ため                                                                           |
| worker を別関数にするか | しない。関数は `*-blog-api` 1 つのまま。Lambda Web Adapter (LWA) が非 HTTP イベントを `AWS_LWA_PASS_THROUGH_PATH`（`POST /events`）へ転送する機能を使い、同一 Axum アプリにルートを 1 本追加するだけにする                                                                            |
| `/events` のガード      | API Gateway の `{proxy+}` 経由で外部からも到達できるため、封筒に `X-Hub-Signature-256` と body（base64）を積み、処理前に HMAC を必ず再検証する                                                                                                                                        |
| Lambda API への経路     | blog-api の Lambda は NAT なし VPC 内のため squid（`HTTPS_PROXY`）の CONNECT トンネル経由。AWS SDK (Rust) のデフォルト HTTP クライアントはプロキシ環境変数を見ない（`ProxyConfig::disabled`）ので、`aws-smithy-http-client` の `ProxyConfig::from_env()` を明示したコネクタを構成する |
| ローカル開発            | `AWS_LAMBDA_FUNCTION_NAME` が無ければ invoker を構築せず、従来どおりインライン処理にフォールバック                                                                                                                                                                                    |
| 自己 invoke の IAM      | `grantInvoke(自身)` は Function ⇔ DefaultPolicy の循環依存で synth 不能。関数名は物理名固定（`${physicalPrefix}-blog-api`）なので ARN を文字列で組み立てて参照を切る                                                                                                                  |
| 差分ファイルのみの処理  | 今回はやらない。全記事スキャンの意味論（毎 push で全件同期）を維持したまま非同期化のみ行う。Event invoke は失敗時に 2 回自動リトライされ、処理は upsert ベースで冪等                                                                                                                  |

## 変更内容

| レイヤー                                   | 変更                                                                                                                                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `infrastructure/src/lambda/mod.rs`（新規） | `SelfInvoker` トレイトと `LambdaSelfInvoker`。プロキシ対応の HTTP クライアントで `aws-sdk-lambda` の `Invoke`（`InvocationType=Event`）を呼ぶ                                                                 |
| `api/src/handler/webhooks.rs`              | 受付（`/webhooks/github`）と実処理（`process_push_event`）を分離。受付は封筒を自己 invoke して `accepted` を返す。`POST /events` が封筒の署名再検証後に実処理を実行。fetch 失敗時のエラーにファイルパスを出力 |
| `registry` / `src/bin/app.rs`              | `self_invoker` を DI に追加し起動時に構築                                                                                                                                                                     |
| `iac/aws/lib/api/blog-api-construct.ts`    | 自関数への `lambda:InvokeFunction` 付与、`AWS_LWA_PASS_THROUGH_PATH=/events` を明示                                                                                                                           |
| 依存追加                                   | `aws-sdk-lambda` / `aws-smithy-http-client`（rustls-aws-lc）/ `aws-smithy-runtime-api`                                                                                                                        |

## 調査メモ（原因特定の手順）

再調査が必要になったときのために、今回使った確認コマンドを残す。

```bash
# webhook の受信/完了ログから処理時間を出す（JST 変換は date -r）
aws logs filter-log-events --log-group-name /aws/lambda/p-st-blog-api \
  --start-time <epoch_ms> --filter-pattern '"Received GitHub webhook"' \
  --query 'events[].[timestamp]' --output text
aws logs filter-log-events --log-group-name /aws/lambda/p-st-blog-api \
  --start-time <epoch_ms> --filter-pattern '"Webhook processing complete"' \
  --query 'events[].[timestamp]' --output text
```

- `aws logs tail` は高流量時にイベントを取りこぼすため、件数を数える用途では `filter-log-events` を使う
- webhook が DB を更新したかは `articles.updated_at` と処理完了ログの時刻照合で判別できる（`updated_at` に `ON UPDATE` は無く、webhook の upsert だけが明示的に書く）
- GitHub 側の失敗が「タイムアウト表示だけ」か「本当に反映されていない」かは切り分けること。今回は 17:39 の push で poem 記事の取得が GitHub API の 502（4 件failed の中）に含まれ、17:50 の手動再配信で反映されていた

## dev での検証

GitHub App の webhook は本番 (api.shuntaka.dev) に向いているため、dev は署名付きリクエストを手動で送って確認する。

```bash
# dev の webhook secret を SSM から取得して HMAC を付与
SECRET=$(aws ssm get-parameter --name <GH_WEBHOOK_SECRET_KEY_NAME の dev キー> --with-decryption --query Parameter.Value --output text)
BODY='<push イベントの JSON>'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')"
curl -s -X POST https://<dev の API ドメイン>/webhooks/github \
  -H "X-GitHub-Event: push" -H "X-Hub-Signature-256: $SIG" \
  -H "Content-Type: application/json" -d "$BODY"
# => {"status":"accepted","message":"Queued for async processing"} が 1〜2 秒で返る
# 実処理の完走は d-st-blog-api のログで "Webhook processing complete" を確認
aws logs tail /aws/lambda/d-st-blog-api --since 10m --format short | grep -E "Received|complete|events"
```

本番反映後は article リポジトリへの push（または Recent Deliveries の Redeliver）で、配信が 200 になることと記事反映を確認する。

## 作業ログ

### 2026-07-13

- 原因調査（処理時間の推移、GitHub 502 による部分失敗、`slug=unknown` 問題の発見）
- 実装 + PR [#625](https://github.com/shuntaka9576/shuntaka-dev/pull/625) 作成（CI green）
- dev デプロイ（stack=main）を workflow_dispatch で実行 → self-hosted runner の Rancher Desktop が Docker ビルド中に落ちて失敗（`rpc error: Unavailable / EOF`。コード起因ではない）

### 2026-07-14

- デプロイ失敗が継続。原因は Mac mini の Rancher Desktop VM のメモリ不足（`cargo chef cook --release` 中に rustc が OOM Kill）。VM メモリ増強で解決し、dev デプロイ成功
- dev E2E 検証で 2 つの dev 環境固有の問題を発見・解消
  - `blog_dev.users.github_installation_id` が prod の値のままで、dev App（shuntaka-blog-api-dev）の installation id と不一致 → 非同期処理がユーザー解決の 404 で終了していた。dev App の installation id（GitHub の Settings → Applications の Configure リンク先 URL 末尾、または webhook payload の `installation.id` で確認できる）に UPDATE して解消
  - **main への push（renovate マージ等）のたびに `deploy.yaml` の push トリガーが dev を main のコードで上書きする**。ブランチ検証中に旧コードへ巻き戻り、インライン処理に見える現象が発生して切り分けに時間を要した。ブランチの dev 検証をするときはこの上書きに注意
- 再デプロイ後、E2E 完走を確認: 受付 0.24 秒で `accepted` → 自己 Event invoke → `/events` で署名再検証 → `Webhook processing complete: processed=1, succeeded=1, failed=0`

## 残課題・注意点

- `infrastructure/src/github/client.rs` の reqwest が `Client::new()` でタイムアウト未設定。squid トンネル経由の接続が刺さると処理がハングし得るため、`Client::builder().timeout(30s)` を別 PR で入れる
- LWA passthrough では、アプリがエラーレスポンス（4xx/5xx）を返しても invocation 自体は成功扱いになるため、**Lambda の Event 自動リトライはクラッシュ/タイムアウト時しか発火しない**。アプリレベルの失敗（GitHub 502 等）は再配信または次回 push でのフルスキャンでカバーされる前提
