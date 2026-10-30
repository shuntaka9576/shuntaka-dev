import {
  type AuthInfo,
  buildOAuthProtectedResourceMetadata,
  getOAuthProtectedResourceMetadataUrl,
  type OAuthMetadata,
  OAuthError,
  OAuthErrorCode,
  requireBearerAuth,
} from '@modelcontextprotocol/server';
import {
  type AuthorizationParams,
  type DCRRequest,
  OAuthProxy,
  OAuthProxyError,
  type TokenStorage,
} from 'fastmcp/auth';
import { Hono } from 'hono';

// 認証ありのエンドポイント用の OAuth。構成は記事 (FastMCP OAuth Proxy + Cognito) と同じで、
// MCP クライアントには DCR・認可・トークンをこのサーバーが提供し、ログインだけを Cognito (admin のユーザープール)
// に任せる。MCP クライアントに渡すのはこのサーバーが署名した JWT で、Cognito のトークンはサーバーの外に出さない。
//
// Cognito の managed login には openid だけを要求する。トークンは MCP の外で使わないため、
// リソースサーバーのスコープは作らない
export const SCOPES = ['openid'];

export interface CognitoClient {
  /** 例: https://xxx.auth.ap-northeast-1.amazoncognito.com */
  domainUrl: string;
  clientId: string;
  clientSecret: string;
}

export interface OAuthKeys {
  jwtSigningKey: string;
  encryptionKey: string;
  consentSigningKey: string;
}

export interface OAuthOptions {
  /** 例: https://mcp.shuntaka.dev */
  baseUrl: string;
  /** 認証ありの MCP エンドポイントのパス (例: /auth/mcp) */
  resourcePath: string;
  cognito: CognitoClient;
  keys: OAuthKeys;
  tokenStorage: TokenStorage;
  redirectUriPolicy: RedirectUriPolicy;
  /** MCP クライアントに渡すリフレッシュトークンの寿命。Cognito のリフレッシュトークンと揃える */
  refreshTokenTtlSeconds: number;
}

export interface RedirectUriPolicy {
  /** DCR で登録を許す HTTPS のホスト。`*.example.com` はサブドメインに一致する */
  httpsHosts: string[];
}

/**
 * 接続を想定する MCP クライアントのリダイレクト先。Muse の 3 つは記事の検証で使った許可リストと同じ
 * (Muse のリダイレクト URI は公開されておらず、ドメイン単位で許可している)
 */
export const DEFAULT_REDIRECT_URI_POLICY: RedirectUriPolicy = {
  httpsHosts: ['agent.meta.ai', 'muse.ai', '*.muse.ai', 'claude.ai', 'claude.com', 'chatgpt.com'],
};

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * DCR で登録できるリダイレクト URI か。fastmcp の allowedRedirectUriPatterns は `*` を `.*` に置き換えるだけで、
 * `http://localhost:*` が `http://localhost:80@evil.example/` にも一致してしまう。URL として分解して判定する
 */
export const isAllowedRedirectUri = (value: string, policy: RedirectUriPolicy): boolean => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username !== '' || url.password !== '' || url.hash !== '') {
    return false;
  }
  // ローカルの MCP クライアント (Claude Code、MCP Inspector など) はループバックの任意ポートで受ける
  if (url.protocol === 'http:') {
    return LOOPBACK_HOSTS.has(url.hostname);
  }
  if (url.protocol !== 'https:' || url.port !== '') {
    return false;
  }
  return policy.httpsHosts.some((host) =>
    host.startsWith('*.') ? url.hostname.endsWith(host.slice(1)) : url.hostname === host,
  );
};

/** JWT の payload を読む。署名と期限は OAuthProxy.loadUpstreamTokens で検証済みのものにだけ使う */
const decodeJwtPayload = (token: string): Record<string, unknown> => {
  const payload = token.split('.')[1] ?? '';
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
};

const toSnakeCase = (value: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`),
      entry,
    ]),
  );

/** RFC 6749 2.3.1 の client_secret_basic。client_id と client_secret は URL エンコードされている */
const parseBasicAuth = (header: string | undefined) => {
  const match = header?.match(/^Basic\s+(.+)$/i);
  if (!match?.[1]) {
    return undefined;
  }
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator < 0) {
    return undefined;
  }
  return {
    clientId: decodeURIComponent(decoded.slice(0, separator)),
    clientSecret: decodeURIComponent(decoded.slice(separator + 1)),
  };
};

export const createOAuth = (options: OAuthOptions) => {
  const proxy = new OAuthProxy({
    baseUrl: options.baseUrl,
    upstreamAuthorizationEndpoint: `${options.cognito.domainUrl}/oauth2/authorize`,
    upstreamTokenEndpoint: `${options.cognito.domainUrl}/oauth2/token`,
    upstreamClientId: options.cognito.clientId,
    upstreamClientSecret: options.cognito.clientSecret,
    upstreamTokenEndpointAuthMethod: 'client_secret_basic',
    scopes: SCOPES,
    // 実際の判定は /oauth/register で isAllowedRedirectUri が行う。ここはその上位集合にしておく
    allowedRedirectUriPatterns: [
      'https://*',
      'http://localhost:*',
      'http://127.0.0.1:*',
      'http://[::1]:*',
    ],
    allowPlainPkce: false,
    consentRequired: true,
    enableCimd: false,
    // Cognito のクレーム (ユーザー名など) を MCP クライアントに渡すトークンへ載せない
    customClaimsPassthrough: false,
    refreshTokenTtl: options.refreshTokenTtlSeconds,
    tokenStorage: options.tokenStorage,
    // 実行環境が入れ替わっても発行済みのトークンと保存済みの状態を読めるよう、鍵は外から固定で渡す
    encryptionKey: options.keys.encryptionKey,
    jwtSigningKey: options.keys.jwtSigningKey,
    consentSigningKey: options.keys.consentSigningKey,
  });

  const resourceUrl = new URL(options.resourcePath, options.baseUrl);
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl);
  const authorizationServerMetadata = {
    ...toSnakeCase(proxy.getAuthorizationServerMetadata()),
    scopes_supported: SCOPES,
  } as OAuthMetadata;
  const protectedResourceMetadata = buildOAuthProtectedResourceMetadata({
    oauthMetadata: authorizationServerMetadata,
    resourceServerUrl: resourceUrl,
    scopesSupported: SCOPES,
    resourceName: 'shuntaka.dev blog',
  });

  // OAuthProxy が発行した JWT を検証し、DynamoDB にトークンの対応が残っていれば通す。
  // 対応を消せば (= DynamoDB の項目を消せば) 期限前でも失効できる
  const authenticate = requireBearerAuth({
    resourceMetadataUrl,
    verifier: {
      async verifyAccessToken(token: string): Promise<AuthInfo> {
        const upstream = await proxy.loadUpstreamTokens(token);
        if (upstream === null) {
          throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid or expired access token');
        }
        const claims = decodeJwtPayload(token);
        return {
          token,
          clientId: String(claims.client_id),
          scopes: Array.isArray(claims.scope) ? claims.scope.map(String) : [],
          expiresAt: Number(claims.exp),
        };
      },
    },
  });

  const routes = new Hono();

  routes.onError((error) => {
    if (error instanceof OAuthProxyError) {
      return error.toResponse();
    }
    console.error(JSON.stringify({ type: 'oauth.error', message: String(error) }));
    return Response.json({ error: 'server_error' }, { status: 500 });
  });

  // 同意画面を iframe に埋め込ませない (クリックジャッキングで同意させられるのを防ぐ)
  routes.use('/oauth/*', async (c, next) => {
    await next();
    c.res.headers.set('X-Frame-Options', 'DENY');
    c.res.headers.set('Content-Security-Policy', "frame-ancestors 'none'");
  });

  routes.get('/.well-known/oauth-authorization-server', (c) => c.json(authorizationServerMetadata));
  for (const path of [
    '/.well-known/oauth-protected-resource',
    `/.well-known/oauth-protected-resource${options.resourcePath}`,
  ]) {
    routes.get(path, (c) => c.json(protectedResourceMetadata));
  }

  routes.post('/oauth/register', async (c) => {
    const body = (await c.req.json().catch(() => null)) as DCRRequest | null;
    if (body === null || typeof body !== 'object' || !Array.isArray(body.redirect_uris)) {
      throw new OAuthProxyError('invalid_client_metadata', 'redirect_uris is required');
    }
    const rejected = body.redirect_uris.find(
      (uri) => typeof uri !== 'string' || !isAllowedRedirectUri(uri, options.redirectUriPolicy),
    );
    if (rejected !== undefined) {
      throw new OAuthProxyError('invalid_redirect_uri', `Redirect URI is not allowed: ${rejected}`);
    }
    return c.json(await proxy.registerClient(body), 201);
  });

  routes.get('/oauth/authorize', async (c) => {
    const params = Object.fromEntries(new URL(c.req.url).searchParams);
    // 要求されたスコープは Cognito に転送される。Cognito はクライアントに許可していないスコープを拒否するため固定する
    params.scope = SCOPES.join(' ');
    return proxy.authorize(params as unknown as AuthorizationParams);
  });

  routes.post('/oauth/consent', (c) => proxy.handleConsent(c.req.raw));

  routes.get('/oauth/callback', (c) => proxy.handleCallback(c.req.raw));

  routes.post('/oauth/token', async (c) => {
    const params = new URLSearchParams(await c.req.text());
    const basic = parseBasicAuth(c.req.header('authorization'));
    const client = {
      client_id: basic?.clientId ?? params.get('client_id') ?? '',
      client_secret: basic?.clientSecret ?? params.get('client_secret') ?? undefined,
    };
    switch (params.get('grant_type')) {
      case 'authorization_code':
        return c.json(
          await proxy.exchangeAuthorizationCode({
            ...client,
            grant_type: 'authorization_code',
            code: params.get('code') ?? '',
            code_verifier: params.get('code_verifier') ?? undefined,
            redirect_uri: params.get('redirect_uri') ?? '',
          }),
        );
      case 'refresh_token':
        // scope は Cognito のトークン更新に転送される。Cognito の更新ではスコープを変えられないため渡さない
        return c.json(
          await proxy.exchangeRefreshToken({
            ...client,
            grant_type: 'refresh_token',
            refresh_token: params.get('refresh_token') ?? '',
          }),
        );
      default:
        throw new OAuthProxyError('unsupported_grant_type', 'Unsupported grant_type');
    }
  });

  return { routes, authenticate, resourceMetadataUrl, proxy };
};

export type OAuth = ReturnType<typeof createOAuth>;
