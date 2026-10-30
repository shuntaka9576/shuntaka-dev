# ブログの MCP サーバー（mcp.<fqdn>）の追加と Muse からの接続確認

- 起票日: 2026-10-30
- 対象: apps/mcp-server（新規）、iac/aws（McpStack 新規、AdminStack / MainStack / VirginiaCertificateStack / DeployRoleStack）、deploy workflow
- ステータス: dev に適用済み（2026-10-30）。Muse からの接続確認は未実施。prd は未適用
- ブランチ: `feat/blog-mcp-server`（PR 未作成）
- 関連:
  - 記事「Muse で AWS 上の Remote MCP Server 向けの Custom Connector 作成を試す」と検証リポジトリ [shuntaka9576/muse-mcp-server-test](https://github.com/shuntaka9576/muse-mcp-server-test)
  - [Lambda Web Functions + CloudFront OAC への移行検討](../2026-10-15-lambda-web-functions-survey/index.md)
  - [logs 管理画面（admin.shuntaka.dev）のアーキテクチャ決定と実装計画](../2026-07-12-logs-admin-architecture/index.md)（流用した Cognito ユーザープール）

## 背景

Muse の Custom Connector を検証した記事では、DCR に対応した認証ありの Remote MCP は Muse にコネクターとして登録され、認証なしの Remote MCP はコネクターとして認識されなかった（それでも Muse 内のクライアントからツールは呼べた）。ブログの記事を Muse などの AI エージェントから読めるよう、認証あり・なしの両方で MCP サーバーを公開する。

記事は Python（FastMCP）の OAuth Proxy と AgentCore Gateway の構成だった。今回は TypeScript で 1 つのサーバーにまとめた。

## 構成

![アーキテクチャ図](../../01_開発ドキュメント/assets/architecture.drawio.png)

| エンドポイント                | 認証                                        | 用途                                        |
| ----------------------------- | ------------------------------------------- | ------------------------------------------- |
| `https://mcp.<fqdn>/mcp`      | なし                                        | 誰でも使える読み取り専用の MCP              |
| `https://mcp.<fqdn>/auth/mcp` | OAuth（DCR・PKCE S256、Cognito でログイン） | Muse などで Custom Connector として登録する |

両方とも同じ 4 ツールを公開する。blog-api の公開 API（`https://<fqdn>/api`）を呼ぶだけで、公開済みの記事しか返さない。

| ツール            | 処理                                                        |
| ----------------- | ----------------------------------------------------------- |
| `search_articles` | セマンティック検索（`/articles/search`）                    |
| `list_articles`   | 新しい順の一覧。タグで絞り込める（`/articles`）             |
| `get_article`     | slug を指定して Markdown の本文を取得（`/articles/{slug}`） |
| `list_tags`       | タグごとの記事数（`/articles/tag-facets`）                  |

記事の構成との違い。

| 項目             | 記事（muse-mcp-server-test）                   | 今回                                                         |
| ---------------- | ---------------------------------------------- | ------------------------------------------------------------ |
| 言語             | Python（FastMCP 4.1.4 の OIDCProxy）           | TypeScript（MCP SDK v2 + fastmcp（TS 版）の `OAuthProxy`）   |
| ツールの実行     | AgentCore Gateway → Lambda                     | MCP サーバーの中で blog-api の公開 API を呼ぶ                |
| 認証なしの接続先 | 別の Gateway                                   | 同じサーバーの `/mcp`                                        |
| Cognito          | 専用のユーザープール                           | admin のユーザープール（admin 画面と同じユーザーでログイン） |
| URL              | Web Functions のエンドポイントの URL           | `mcp.<fqdn>`（専用の CloudFront）                            |
| トークンの期限   | アクセス 15 分 / Cognito のリフレッシュ 1 時間 | アクセス 1 日 / リフレッシュ 30 日                           |

## 設計上の判断

- **Web Function の endpoint は OAC を使わない `ApplicationManaged`**。OAC で viewer の `Authorization` が残るかはドキュメント上はっきりせず（[移行検討の未検証事項](../2026-10-15-lambda-web-functions-survey/index.md#未検証事項)）、Bearer トークンが届かないと認証ありのエンドポイントが成り立たない。CloudFront はキャッシュポリシーで `Authorization` をキャッシュキーに入れて転送し、アプリはすべての応答に `Cache-Control: no-store` を付ける
- **トークンの期限を延ばした**。記事の検証では 2 回 401 になった。1 回目はトークン更新がコールドスタートと重なり、MCP クライアントが新しいリフレッシュトークンを受け取れなかった。2 回目は Cognito のリフレッシュトークン（1 時間）が切れた。アクセストークンを 1 日にして更新の回数を減らし、リフレッシュトークンは 30 日にした（`iac/aws/lib/mcp/mcp-oauth.ts`）。ツールは公開記事の読み取りだけで、発行済みのトークンは DynamoDB の項目を消せば期限前でも失効できる
- **DCR のリダイレクト先は URL として分解して判定する**。fastmcp の `allowedRedirectUriPatterns` は `*` を `.*` に置き換えるだけで、`http://localhost:*/callback` が `http://localhost:80@evil.example/callback` にも一致する。`apps/mcp-server/src/oauth.ts` の `isAllowedRedirectUri` で、ホストの完全一致（`*.` はサブドメイン）とループバックだけを許す
- **Cognito に送るスコープは `openid` に固定する**。`OAuthProxy` は MCP クライアントが要求したスコープをそのまま Cognito に転送し、Cognito はクライアントに許可していないスコープを拒否するため
- **証明書を `<fqdn>` + `*.<fqdn>` の 1 枚にまとめた**。mcp 用に証明書を足す代わりにワイルドカード証明書を作り、apex・admin・images・mcp の CloudFront をすべてそれに切り替えた。旧証明書 2 枚はまだ CloudFront が使っているため同じデプロイでは消せない（証明書スタックは参照側より先にデプロイされる）。dev / prd に反映した後、別 PR で消す
- **blog-api へのクエリは `%20` で送る**。調査中に、クエリに `+`（空白の別表記）が入ると CloudFront OAC 経由の blog-api が 403 を返すことが分かった（dev / prd とも。`%20` なら 200）。apps/web は `encodeURIComponent` を使っているため影響はない。MCP サーバーも `URLSearchParams` ではなく `encodeURIComponent` でクエリを組み立てる

## 作業記録（dev）

### 1. CI のデプロイロールに dynamodb:\* を追加する

DynamoDB を使うスタックが増えたため、CI のデプロイロールに `dynamodb:*` を足した。デプロイロールは CI のデプロイ対象外なので手動で反映する。

```bash
aws-vault exec <shuntaka-dev のプロファイル名>
aws sts get-caller-identity --query Account --output text   # d-st-* のスタックがあるアカウントであること
cd iac/aws
bunx dotenv -- cdk deploy -c stageName=dev d-st-deploy-role --exclusively --require-approval never
```

:::{note}
最初は別アカウントのプロファイルで実行してしまい、`Unable to fetch parameters [/shuntaka/github-oidc-provider-arn] from parameter store for this account.` で失敗した。変更セットを作る前に失敗したため、そのアカウントのリソースは変わっていない（CDK の bootstrap バケットにテンプレートがアップロードされただけ）。実行前に `aws sts get-caller-identity` で `d-st-*` のスタックがあるアカウントかを確かめる。
:::

### 2. ワークフローで dev へデプロイする

```bash
gh workflow run deploy.yaml --ref feat/blog-mcp-server -f stageName=dev -f stack=all
```

`all` は st-tidb-proxy → st-tidb-proxy-logs → main → admin → mcp の順にデプロイする。main の依存として証明書スタック（ワイルドカード証明書の作成）も先にデプロイされる。[実行結果](https://github.com/shuntaka9576/shuntaka-dev/actions/runs/40978802365)はすべてのステップが成功した。

### 3. 動作確認

```bash
B=https://mcp.shuntaka.me
H=(-H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H 'mcp-protocol-version: 2025-06-18')

# 認証なし: ツールの一覧と検索
curl -s "${H[@]}" $B/mcp -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
curl -s "${H[@]}" $B/mcp -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_articles","arguments":{"query":"Lambda Web Functions の移行","limit":3}}}'

# 認証あり: トークンなしは 401 と resource_metadata
curl -s -o /dev/null -D - "${H[@]}" $B/auth/mcp -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
curl -s $B/.well-known/oauth-protected-resource/auth/mcp
curl -s $B/.well-known/oauth-authorization-server
```

| 確認                        | 結果                                                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `GET /`                     | 200。2 つのエンドポイントの URL を返す                                                                                 |
| `/mcp` の `tools/list`      | 4 ツール                                                                                                               |
| `/mcp` の `search_articles` | 79 件中の上位 3 件を記事の URL 付きで返した                                                                            |
| `/auth/mcp`（トークンなし） | 401。`WWW-Authenticate` に `resource_metadata="https://mcp.shuntaka.me/.well-known/oauth-protected-resource/auth/mcp"` |
| 保護リソースのメタデータ    | `authorization_servers: ["https://mcp.shuntaka.me"]`、`scopes_supported: ["openid"]`                                   |
| 認可サーバーのメタデータ    | `registration_endpoint: https://mcp.shuntaka.me/oauth/register`、`code_challenge_methods_supported: ["S256"]`          |

DCR からトークン更新までの流れ（登録 → 同意 → Cognito → トークン交換 → ツール呼び出し → 更新、使用済みリフレッシュトークンの拒否）は、Cognito をモックした `apps/mcp-server/src/oauth.test.ts` で確認している。実際の Cognito でのログインは次の Muse の接続で確認する。

## Muse から接続する（未実施）

Muse で新しいサイドチャットを作り、次のプロンプトを送る。途中でこのサーバーの同意画面（Approve / Deny）と Cognito のログイン画面が開く。ログインには dev の admin 画面（`admin.shuntaka.me`）と同じユーザーを使う。

```text
Create a Custom Connector for my remote MCP server.

Name: custom.shuntaka-blog-dev
Transport: Streamable HTTP
URL: https://mcp.shuntaka.me/auth/mcp
Authentication: OAuth 2.0 Authorization Code with PKCE (S256)
Client registration: Dynamic Client Registration (DCR)

Discover the OAuth metadata, register the client, and guide me through the login.
After login, discover the available tools and test the connection.
```

認証なしは、URL を `https://mcp.shuntaka.me/mcp` にし、`Authentication` 以下の行を外す。

| 確認すること                 | 期待                                                                                               |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| DCR                          | 成功する。`invalid_redirect_uri` になったら Muse のリダイレクト URI を許可リストに足す（下記）     |
| 同意画面・Cognito のログイン | ログイン後に Muse の画面へ戻り、コネクターが追加済みになる                                         |
| コネクター画面               | 認証ありはカスタムコネクターとして表示される。認証なしは表示されない（記事と同じか）               |
| ツール                       | 「Lambda Web Functions の記事を探して」で `search_articles`、本文の要約で `get_article` が呼ばれる |
| トークン更新                 | 1 日以上空けて依頼しても 401 にならない（記事の 1 回目・2 回目の失敗が起きない）                   |

DCR で登録を許すリダイレクト先は `apps/mcp-server/src/oauth.ts` の `DEFAULT_REDIRECT_URI_POLICY`（`agent.meta.ai`・`muse.ai`・`*.muse.ai`・`claude.ai`・`claude.com`・`chatgpt.com` とループバック）。Muse の 3 つは記事の検証で使った許可リストと同じで、Muse の実際のリダイレクト URI は公開されていない。

## ログの確認

MCP サーバーのログは `/aws/lambda-web/d-st-mcp-server`。1 行 1 JSON で、`type` で種類を見分ける。

| `type`        | 内容                                                                            |
| ------------- | ------------------------------------------------------------------------------- |
| `app.ready`   | 実行環境の起動（`initMs` が起動にかかった時間）                                 |
| `app.request` | リクエストごと。`coldStart`・`path`・`status`・`durationMs`                     |
| `mcp.tool`    | ツール呼び出しごと。`tool`・`endpoint`（`public` / `auth`）・`ok`・`durationMs` |
| `oauth.error` | OAuth のルートで想定外のエラー                                                  |

```bash
aws logs tail /aws/lambda-web/d-st-mcp-server --since 30m --format short \
  | grep -E 'app.ready|app.request|mcp.tool|oauth.error'
```

発行済みのトークンを失効させるときは、OAuth の状態のテーブル（mcp stack の出力 `OAuthStateTableName`）から項目を消す。全部消すと、すべての MCP クライアントが再認証になる。

## 残作業

- [ ] Muse から接続を確認する（認証あり・なし）
- [ ] PR を作ってレビュー・マージする
- [ ] prd のデプロイロールに `dynamodb:*` を手動で反映する（`p-st-deploy-role`）。リリース前に必要
- [ ] dev / prd に反映した後、旧証明書 2 枚（`VirginiaCertificate` / `WebCertificate`）と SSM パラメータを別 PR で消す
- [ ] （任意）dev の CDK bootstrap が古い（バージョン 21 未満）と通知が出ている。今回の変更とは関係ない
