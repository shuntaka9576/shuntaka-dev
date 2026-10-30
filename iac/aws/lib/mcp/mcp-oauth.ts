import * as cdk from 'aws-cdk-lib';

// MCP サーバー (apps/mcp-server) の OAuth 設定のうち、Cognito のアプリクライアント (AdminStack) と
// MCP サーバー (McpStack) で揃える値
export const MCP_OAUTH = {
  /** MCP サーバーが Cognito から認可コードを受け取るパス */
  callbackPath: '/oauth/callback',
  // MCP サーバーが MCP クライアントに渡すアクセストークンの期限は、Cognito のアクセストークンの期限と同じになる。
  // 記事の検証では、期限切れのたびに走るトークン更新がコールドスタートと重なり、MCP クライアントが新しい
  // リフレッシュトークンを受け取れず再認証になった。ツールは公開記事の読み取りだけなので長めにして更新の回数を減らす
  // (発行済みのトークンは DynamoDB の対応を消せば期限前でも失効できる)
  accessTokenValidity: cdk.Duration.days(1),
  // Cognito のリフレッシュトークンは使っても期限が延びない。記事の検証では 1 時間にしていたため、
  // ログインから 1 時間後の更新が Cognito に拒否されて再認証になった。MCP サーバー側のリフレッシュトークンも同じ期限にする
  refreshTokenValidity: cdk.Duration.days(30),
} as const;
