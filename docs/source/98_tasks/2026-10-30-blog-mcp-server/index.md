# ブログの MCP サーバー（mcp.<fqdn>）の追加と Muse からの接続確認

- 起票日: 2026-10-30
- 対象: apps/mcp-server（新規）、iac/aws（McpStack 新規、AdminStack / MainStack / VirginiaCertificateStack / DeployRoleStack）、deploy workflow
- ステータス: 最初の実装（fastmcp の `OAuthProxy`）を dev に適用し、Muse から接続できた（2026-10-30）。レビュー指摘を受けて認可サーバーを自前の実装に置き換え、ローカルで確認済み。dev への再適用は未実施。prd は未適用
- ブランチ: `feat/blog-mcp-server`（[PR #828](https://github.com/shuntaka9576/shuntaka-dev/pull/828)）
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
| 言語             | Python（FastMCP 4.1.4 の OIDCProxy）           | TypeScript（MCP SDK v2 + 自前の認可サーバー）                |
| ツールの実行     | AgentCore Gateway → Lambda                     | MCP サーバーの中で blog-api の公開 API を呼ぶ                |
| 認証なしの接続先 | 別の Gateway                                   | 同じサーバーの `/mcp`                                        |
| Cognito          | 専用のユーザープール                           | admin のユーザープール（admin 画面と同じユーザーでログイン） |
| URL              | Web Functions のエンドポイントの URL           | `mcp.<fqdn>`（専用の CloudFront）                            |
| トークンの期限   | アクセス 15 分 / Cognito のリフレッシュ 1 時間 | アクセス 1 日 / ログイン 30 日                               |

## 設計上の判断

- **Web Function の endpoint は OAC を使わない `ApplicationManaged`**。OAC で viewer の `Authorization` が残るかはドキュメント上はっきりせず（[移行検討の未検証事項](../2026-10-15-lambda-web-functions-survey/index.md#未検証事項)）、Bearer トークンが届かないと認証ありのエンドポイントが成り立たない。CloudFront はキャッシュポリシーで `Authorization` をキャッシュキーに入れて転送し、アプリはすべての応答に `Cache-Control: no-store` を付ける
- **認可サーバーは自前で書いた**。最初は fastmcp（TS 版）の `OAuthProxy` を使ったが、レビューで OAuth の基本の確認が抜けていることが分かった（[4. レビュー指摘を受けて認可サーバーを置き換える](#4-レビュー指摘を受けて認可サーバーを置き換える)）。fastmcp の外側で補うと内部の挙動に頼ることになるため、`apps/mcp-server/src/oauth/` に DCR・認可・同意・Cognito 連携・トークン発行を書き直した。保証する性質は `src/oauth/index.ts` の冒頭に並べ、1 つずつ `src/oauth/oauth.test.ts` で確かめている
- **トークンの期限を延ばした**。記事の検証では 2 回 401 になった。1 回目はトークン更新がコールドスタートと重なり、MCP クライアントが新しいリフレッシュトークンを受け取れなかった。2 回目は Cognito のリフレッシュトークン（1 時間）が切れた。アクセストークンを 1 日にして更新の回数を減らし、ログインの有効期間（Cognito のリフレッシュトークンの期限）は 30 日にした（`iac/aws/lib/mcp/mcp-oauth.ts`）。1 回目への手当てとして、更新の応答を受け取れなかったクライアントは直前のリフレッシュトークンで 2 分以内なら再送でき、同じ後継トークンを受け取る
- **リフレッシュトークンは `<grant ID>.<世代>.<HMAC>`**。使うたびに世代が進む。HMAC で発行済みのものかを確かめられるため、猶予を過ぎた古い世代が使われたら盗まれたとみなして grant ごと失効させる（RFC 9700 4.14.2）。grant ID はアクセストークンの中身から読めるが、HMAC は作れないため、無効なトークンで失効させることはできない
- **アクセストークンは JWT（`typ: at+jwt`）だが、検証のたびに grant の存在を確かめる**。DynamoDB の grant（`grant#<ID>`）を消せば、期限前でも失効する
- **同意画面と Cognito からの戻りは、認可要求を始めたブラウザに Cookie で紐付ける**。他人に送りつけた同意フォームや Cognito のログイン URL では進められない。Cookie は `__Host-` 付きで、兄弟のサブドメイン（admin・images）からは書き込めない
- **DCR のリダイレクト先は URL として分解して判定する**。glob（fastmcp の `allowedRedirectUriPatterns` は `*` を `.*` に置き換えるだけ）では `http://localhost:*/callback` が `http://localhost:80@evil.example/callback` にも一致する。`apps/mcp-server/src/oauth/redirect-uri.ts` の `isAllowedRedirectUri` で、ホストの完全一致（`*.` はサブドメイン）とループバックだけを許す
- **MCP クライアントに渡すスコープは `blog:read` 1 つ**。要求されたスコープにかかわらずこれを付ける。Cognito には常に `openid` だけを要求する
- **ローカルでは Cognito の代わりに仮ログインを使う**。`bun dev` だけで認証ありのエンドポイントまで試せるようにするため（AWS の認証も、Cognito に localhost の戻り先を登録することも要らない）。認可サーバーから見た振る舞いは Cognito と同じにしてあり、本物の Cognito とのつなぎ込みは dev で確かめる
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

この時点の実装は fastmcp の `OAuthProxy` で、メタデータの `scopes_supported` は `openid` だった。

### 4. レビュー指摘を受けて認可サーバーを置き換える

Codex に PR をレビューしてもらい、fastmcp 4.23.8（最新版）のソースと突き合わせて指摘がすべて実装どおりであることを確かめた。

| 指摘                                                                                    | 対応                                                                                       |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| アクセストークンとリフレッシュトークンが同じ形の JWT で、取り違えても通る               | アクセストークンは `typ: at+jwt` の JWT、リフレッシュトークンは JWT ではない値にした       |
| `allowPlainPkce: false` でも `code_challenge` なしの認可要求が通る                      | 認可要求で S256 の `code_challenge` を必須にした                                           |
| トークンエンドポイントでクライアントシークレットを照合せず、更新で `client_id` も見ない | シークレットを持つクライアントは照合し、リフレッシュトークンは発行先のクライアントに限った |
| 認可コードの交換で `redirect_uri` を照合しない                                          | 認可コードに認可要求の `redirect_uri` を保存して照合する                                   |
| 同意画面がブラウザに紐付いておらず、DCR のクライアントが期限なしで残る                  | Cookie でブラウザに紐付け、すべての状態に期限を付けた                                      |

置き換えた実装をもう一度レビューしてもらい、次の指摘も直した。

| 指摘                                                                                                        | 対応                                                                                                      |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| McpStack が新しい環境変数（`ACCESS_TOKEN_TTL_SECONDS` / `SESSION_TTL_SECONDS`）を渡しておらず、起動できない | McpStack の環境変数を付け替えた                                                                           |
| 再送や同時の更新で、届いた後継トークンが無効になる                                                          | リフレッシュトークンを世代と HMAC の形にし、再送や同時の更新には同じ後継トークンを返す                    |
| 盗まれたリフレッシュトークンが先に使われると、盗んだ側が更新を続けられる                                    | 猶予を過ぎた発行済みの古い世代が使われたら grant ごと失効させる                                           |
| ローカル用のストアの `take` が同時に呼ばれると、同じ認可コードを 2 回返す                                   | 読み出しから削除までの間に `await` を挟まないようにした                                                   |
| （提案）別のリソースを指す `resource`、Cognito の ID トークンのクレーム                                     | `resource` が自分以外なら `invalid_target` で断り、ID トークンの `iss`・`aud`・`exp` を確かめるようにした |

ローカルでは `bun dev` で起動し、Claude Code から `/auth/mcp` につないで、同意画面 → 仮ログイン → ツール呼び出しまで通ることを確かめた。

## Muse から接続する

最初の実装（fastmcp 版）で、Muse から認証ありのエンドポイントにログインまで通ることを確かめた。Muse が出した接続リンク（`muse.ai/connect/oauth`）の `spec`（base64）が 3 文字欠けていて、Muse の接続ページが「必須パラメーターがありません」を出したため、欠けた部分を補ったリンクを開いた。認可サーバーを置き換えたため、dev に再適用したら接続し直す。

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

DCR で登録を許すリダイレクト先は `apps/mcp-server/src/oauth/redirect-uri.ts` の `DEFAULT_REDIRECT_URI_POLICY`（`agent.meta.ai`・`muse.ai`・`*.muse.ai`・`claude.ai`・`claude.com`・`chatgpt.com` とループバック）。Muse の 3 つは記事の検証で使った許可リストと同じで、Muse の実際のリダイレクト URI は公開されていない。

## ログの確認

MCP サーバーのログは `/aws/lambda-web/d-st-mcp-server`。1 行 1 JSON で、`type` で種類を見分ける。

| `type`                | 内容                                                                            |
| --------------------- | ------------------------------------------------------------------------------- |
| `app.ready`           | 実行環境の起動（`initMs` が起動にかかった時間）                                 |
| `app.request`         | リクエストごと。`coldStart`・`path`・`status`・`durationMs`                     |
| `mcp.tool`            | ツール呼び出しごと。`tool`・`endpoint`（`public` / `auth`）・`ok`・`durationMs` |
| `oauth.error`         | OAuth のルートで想定外のエラー、Cognito とのやり取りの失敗                      |
| `oauth.refresh_reuse` | 発行済みの古いリフレッシュトークンが使われ、grant を失効させた（`clientId`）    |

```bash
aws logs tail /aws/lambda-web/d-st-mcp-server --since 30m --format short \
  | grep -E 'app.ready|app.request|mcp.tool|oauth\.'
```

発行済みのトークンを失効させるときは、OAuth の状態のテーブル（mcp stack の出力 `OAuthStateTableName`）から grant（`grant#<ID>`）を消す。全部消すと、すべての MCP クライアントが再認証になる。

## 残作業

- [x] 置き換えた認可サーバーを dev に再適用する（[実行結果](https://github.com/shuntaka9576/shuntaka-dev/actions/runs/41005357698)。`/mcp` のツール呼び出し、`/auth/mcp` の 401 とメタデータ、DCR → 同意画面 → Cognito のログイン画面まで確認）
- [ ] Muse から接続し直す（認証あり・なし。ツール呼び出しとトークン更新まで）
- [ ] dev の OAuth の状態のテーブルから、fastmcp 版の項目（`client:` / `mapping:` / `upstream:` などで始まり、期限なし）を消す。暗号化した Cognito のリフレッシュトークンを含む
- [ ] PR #828 をマージする
- [ ] prd のデプロイロールに `dynamodb:*` を手動で反映する（`p-st-deploy-role`）。リリース前に必要
- [ ] 証明書を us-east-1 のワイルドカード 1 枚にまとめる。旧証明書 2 枚と使っていない東京の証明書を消す。この PR の prd リリース後に、[証明書を us-east-1 のワイルドカード 1 枚にまとめる](../2026-10-30-unify-certificates/index.md)で行う
- [ ] （検討）認証の要る・要らないでツールを分ける。今は両方のエンドポイントが同じ公開記事のツールを出している
- [ ] （任意）dev の CDK bootstrap が古い（バージョン 21 未満）と通知が出ている。今回の変更とは関係ない
