// ローカル実行。既定では認証なしの /mcp だけを http://localhost:8787 で起動する。
//
// 認証ありの /auth/mcp も試すときは、AWS 認証済みのシェルで COGNITO_USER_POOL_ID / COGNITO_CLIENT_ID /
// COGNITO_DOMAIN_URL を渡す (値は dev の SSM `/dev/shuntaka/admin/mcp-*`)。dev の Cognito クライアントには
// http://localhost:8787/oauth/callback を登録してある。OAuth の状態はメモリに置くため、再起動すると消える
import { randomBytes } from 'node:crypto';
import { serve } from '@hono/node-server';
import { MemoryTokenStorage } from 'fastmcp/auth';
import { createApp } from './app.js';
import { BlogApiClient } from './blog-api.js';
import { createOAuth, DEFAULT_REDIRECT_URI_POLICY } from './oauth.js';
import { deriveKeys, getCognitoClientSecret } from './secrets.js';

const port = 8787;
const baseUrl = `http://localhost:${port}`;
const userName = process.env.BLOG_USER_NAME ?? 'shuntaka';
const siteUrl = process.env.SITE_URL ?? 'https://shuntaka.me';

const createDevOAuth = async () => {
  const { COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID, COGNITO_DOMAIN_URL } = process.env;
  if (!COGNITO_USER_POOL_ID || !COGNITO_CLIENT_ID || !COGNITO_DOMAIN_URL) {
    return undefined;
  }
  const region = process.env.AWS_REGION ?? 'ap-northeast-1';
  return createOAuth({
    baseUrl,
    resourcePath: '/auth/mcp',
    cognito: {
      domainUrl: COGNITO_DOMAIN_URL,
      clientId: COGNITO_CLIENT_ID,
      clientSecret: await getCognitoClientSecret({
        region,
        userPoolId: COGNITO_USER_POOL_ID,
        clientId: COGNITO_CLIENT_ID,
      }),
    },
    keys: deriveKeys(randomBytes(32).toString('hex')),
    tokenStorage: new MemoryTokenStorage(),
    redirectUriPolicy: DEFAULT_REDIRECT_URI_POLICY,
    refreshTokenTtlSeconds: 30 * 24 * 60 * 60,
  });
};

const oauth = await createDevOAuth();
const app = createApp({
  baseUrl,
  blogApi: new BlogApiClient({
    baseUrl: process.env.BLOG_API_URL ?? `${siteUrl}/api`,
    userName,
  }),
  siteUrl,
  userName,
  oauth,
});

serve({ fetch: app.fetch, port }, () => {
  console.log(`public: ${baseUrl}/mcp`);
  if (oauth) {
    console.log(`authenticated: ${baseUrl}/auth/mcp`);
  }
});
