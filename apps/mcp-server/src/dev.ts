// ローカル実行 (`bun dev`、または apps/mcp-server で `bun run dev`)。認証なしの /mcp と認証ありの /auth/mcp を起動する。
//
// 認証ありのログインは Cognito の代わりに src/dev-login.ts の仮ログインを使うため、AWS の認証は要らない。
// 本物の Cognito とのつなぎ込みは dev 環境で確かめる。認可の状態と鍵はメモリに置くため、再起動するとログインし直しになる
import { randomBytes } from 'node:crypto';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { AUTH_MCP_PATH, createApp, PUBLIC_MCP_PATH } from './app.js';
import { BlogApiClient } from './blog-api.js';
import { createDevLogin } from './dev-login.js';
import { createOAuth } from './oauth/index.js';
import { DEFAULT_REDIRECT_URI_POLICY } from './oauth/redirect-uri.js';
import { MemoryStore } from './oauth/store.js';
import { deriveKeys } from './secrets.js';

// ポートは worktree ごとに wt.toml が .env.local に採番する (admin-api の src/dev.ts と同じ読み方)
for (const envFile of ['../../.env.local', '.env.local']) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    // ファイルが無ければ次へ進み、最終的に direnv / シェルの環境変数を使う
  }
}

const port = Number(process.env.MCP_SERVER_PORT ?? 43008);
const baseUrl = `http://localhost:${port}`;
const userName = process.env.BLOG_USER_NAME ?? 'shuntaka';
// 記事は dev 環境の公開 API から読む
const siteUrl = process.env.MCP_SITE_URL ?? 'https://shuntaka.me';

const DEV_LOGIN_PATH = '/dev-login';
const devLoginUrl = `${baseUrl}${DEV_LOGIN_PATH}`;
const devLoginClient = {
  clientId: 'local-mcp-server',
  clientSecret: randomBytes(32).toString('hex'),
};

const server = new Hono();
server.route(
  '/',
  createDevLogin({ basePath: DEV_LOGIN_PATH, issuer: devLoginUrl, ...devLoginClient }),
);
server.route(
  '/',
  createApp({
    baseUrl,
    blogApi: new BlogApiClient({ baseUrl: `${siteUrl}/api`, userName }),
    siteUrl,
    userName,
    oauth: createOAuth({
      baseUrl,
      resourcePath: AUTH_MCP_PATH,
      cognito: { domainUrl: devLoginUrl, issuer: devLoginUrl, ...devLoginClient },
      keys: deriveKeys(randomBytes(32).toString('hex')),
      store: new MemoryStore(),
      redirectUriPolicy: DEFAULT_REDIRECT_URI_POLICY,
      accessTokenTtlSeconds: 60 * 60,
      sessionTtlSeconds: 30 * 24 * 60 * 60,
    }),
  }),
);

serve({ fetch: server.fetch, port }, () => {
  console.log(`mcp-server public:        ${baseUrl}${PUBLIC_MCP_PATH}`);
  console.log(
    `mcp-server authenticated: ${baseUrl}${AUTH_MCP_PATH} (sign-in: local stand-in for Cognito)`,
  );
});
