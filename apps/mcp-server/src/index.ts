// Lambda Web Functions のエントリ。runtime がこのファイル (index.mjs) を読み込み、
// サーバーは AWS_LAMBDA_HTTP_ENDPOINT (host:port) で待ち受ける
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { BlogApiClient } from './blog-api.js';
import { DynamoDbStore } from './oauth/dynamodb-store.js';
import { createOAuth } from './oauth/index.js';
import { DEFAULT_REDIRECT_URI_POLICY } from './oauth/redirect-uri.js';
import { createRequestObserver } from './observability.js';
import { deriveKeys, getCognitoClientSecret, getSecretString, requireEnv } from './secrets.js';

const region = requireEnv('APP_AWS_REGION');
const baseUrl = requireEnv('MCP_BASE_URL');
const userPoolId = requireEnv('COGNITO_USER_POOL_ID');
const clientId = requireEnv('COGNITO_CLIENT_ID');

const observer = createRequestObserver();

const [keySecret, clientSecret] = await Promise.all([
  getSecretString(region, requireEnv('KEY_SECRET_ARN')),
  getCognitoClientSecret({ region, userPoolId, clientId }),
]);

const oauth = createOAuth({
  baseUrl,
  resourcePath: '/auth/mcp',
  cognito: {
    domainUrl: requireEnv('COGNITO_DOMAIN_URL'),
    issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`,
    clientId,
    clientSecret,
  },
  keys: deriveKeys(keySecret),
  store: new DynamoDbStore(new DynamoDBClient({ region }), requireEnv('TOKEN_TABLE_NAME')),
  redirectUriPolicy: DEFAULT_REDIRECT_URI_POLICY,
  accessTokenTtlSeconds: Number(requireEnv('ACCESS_TOKEN_TTL_SECONDS')),
  sessionTtlSeconds: Number(requireEnv('SESSION_TTL_SECONDS')),
});

const userName = requireEnv('BLOG_USER_NAME');
const app = createApp({
  baseUrl,
  blogApi: new BlogApiClient({ baseUrl: requireEnv('BLOG_API_URL'), userName }),
  siteUrl: requireEnv('SITE_URL'),
  userName,
  oauth,
  requestObserver: observer.middleware,
});

const address = process.env.AWS_LAMBDA_HTTP_ENDPOINT ?? '127.0.0.1:8787';
const separator = address.lastIndexOf(':');
serve(
  {
    fetch: app.fetch,
    hostname: address.slice(0, separator),
    port: Number(address.slice(separator + 1)),
  },
  observer.markReady,
);

// Lambda は実行環境を消す前に SIGTERM を送ってくる。既定の動作 (シグナルで終了) だと
// spinDownReport が Runtime.ExitError になるため、正常終了として抜ける
process.on('SIGTERM', () => process.exit(0));
