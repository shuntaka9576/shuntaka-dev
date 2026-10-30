import { createMcpHandler } from '@modelcontextprotocol/server';
import { Hono, type MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import type { BlogApiClient } from './blog-api.js';
import type { OAuth } from './oauth/index.js';
import { type Log, stdoutLog } from './observability.js';
import { createBlogMcpServer } from './tools.js';

// 同じツールを 2 つのエンドポイントで公開する。差は認証の有無だけ
export const PUBLIC_MCP_PATH = '/mcp';
export const AUTH_MCP_PATH = '/auth/mcp';

export interface AppOptions {
  /** 例: https://mcp.shuntaka.dev */
  baseUrl: string;
  blogApi: BlogApiClient;
  siteUrl: string;
  userName: string;
  /** 未指定なら認証ありのエンドポイントと OAuth のルートを生やさない (ローカル実行用) */
  oauth?: OAuth;
  requestObserver?: MiddlewareHandler;
  log?: Log;
}

export const createApp = (options: AppOptions) => {
  const log = options.log ?? stdoutLog;
  // リクエストごとに新しい McpServer を作るステートレス構成。2026-07-28 版のリクエストも、
  // 2025 年版 (セッションなしの Streamable HTTP) のリクエストも同じファクトリで受ける
  const mcpHandler = (endpoint: 'public' | 'auth') =>
    createMcpHandler(
      () =>
        createBlogMcpServer({
          blogApi: options.blogApi,
          siteUrl: options.siteUrl,
          userName: options.userName,
          endpoint,
          onToolCall: (record) => log({ type: 'mcp.tool', ...record }),
        }),
      { onerror: (error) => log({ type: 'mcp.error', endpoint, message: error.message }) },
    );
  const publicHandler = mcpHandler('public');
  const authHandler = mcpHandler('auth');

  const app = new Hono();
  if (options.requestObserver) {
    app.use('*', options.requestObserver);
  }
  // 返すものはすべてリクエストごとに変わる (トークンや認可の応答を含む) ため、CloudFront にもブラウザにも残させない
  app.use('*', async (c, next) => {
    await next();
    c.res.headers.set('Cache-Control', 'no-store');
  });
  // ブラウザで動く MCP クライアント (MCP Inspector など) から呼べるようにする。トークンは Cookie ではなく
  // Authorization ヘッダーで送るため、任意のオリジンを許しても他サイトからユーザーの権限で呼ばれることはない
  app.use(
    '*',
    cors({
      origin: '*',
      allowHeaders: [
        'Authorization',
        'Content-Type',
        'Mcp-Protocol-Version',
        'Mcp-Session-Id',
        'Last-Event-ID',
      ],
      exposeHeaders: ['WWW-Authenticate', 'Mcp-Protocol-Version', 'Mcp-Session-Id'],
    }),
  );

  app.get('/', (c) =>
    c.json({
      name: 'shuntaka.dev blog MCP server',
      endpoints: {
        public: `${options.baseUrl}${PUBLIC_MCP_PATH}`,
        ...(options.oauth && { authenticated: `${options.baseUrl}${AUTH_MCP_PATH}` }),
      },
    }),
  );

  app.all(PUBLIC_MCP_PATH, (c) => publicHandler.fetch(c.req.raw));

  const { oauth } = options;
  if (oauth) {
    app.route('/', oauth.routes);
    app.all(AUTH_MCP_PATH, async (c) => {
      // トークンが無い・無効なら 401 と WWW-Authenticate (resource_metadata 付き) を返し、
      // MCP クライアントに OAuth のメタデータの場所を教える
      const auth = await oauth.authenticate(c.req.raw);
      if (auth instanceof Response) {
        return auth;
      }
      return authHandler.fetch(c.req.raw, { authInfo: auth });
    });
  }

  return app;
};
