import * as cdk from 'aws-cdk-lib';

// MCP サーバー (apps/mcp-server) の OAuth 設定のうち、Cognito のアプリクライアント (AdminStack) と
// MCP サーバー (McpStack) で揃える値
export const MCP_OAUTH = {
  /** MCP サーバーが Cognito から認可コードを受け取るパス */
  callbackPath: '/oauth/callback',
  // MCP サーバーが MCP クライアントに渡すアクセストークンの期限。記事の検証では、期限切れのたびに走るトークン更新が
  // コールドスタートと重なり、MCP クライアントが新しいリフレッシュトークンを受け取れず再認証になった。ツールは公開記事の
  // 読み取りだけなので長めにして更新の回数を減らす (grant を消せば期限前でも失効できる)
  accessTokenValidity: cdk.Duration.days(1),
  // ログインの有効期間。MCP サーバーはトークンを更新するたびに Cognito のリフレッシュトークンでユーザーがまだ有効かを
  // 確かめる。Cognito のリフレッシュトークンは使っても期限が延びないため、ログインから 30 日で再認証になる。
  // 記事の検証では 1 時間にしていたため、ログインから 1 時間後の更新が Cognito に拒否されて再認証になった
  sessionValidity: cdk.Duration.days(30),
} as const;
