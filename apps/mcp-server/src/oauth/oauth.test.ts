import { describe, expect, it } from 'bun:test';
import { createApp } from '../app.js';
import { deriveKeys } from '../secrets.js';
import { FakeDynamoDb, createFakeBlogApi, mcpRequest, readMcpResponse } from '../test-helpers.js';
import { randomToken, sha256 } from './crypto.js';
import { DynamoDbStore } from './dynamodb-store.js';
import { createOAuth, SCOPE } from './index.js';
import { DEFAULT_REDIRECT_URI_POLICY, isAllowedRedirectUri } from './redirect-uri.js';
import { MemoryStore, type OAuthStore } from './store.js';

const BASE_URL = 'https://mcp.example.com';
const COGNITO_DOMAIN = 'https://auth.example.com';
const REDIRECT_URI = 'http://localhost:53682/callback';
const ACCESS_TOKEN_TTL_SECONDS = 24 * 60 * 60;
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

describe('isAllowedRedirectUri', () => {
  const allowed = (uri: string) => isAllowedRedirectUri(uri, DEFAULT_REDIRECT_URI_POLICY);

  it('許可したホストの HTTPS とループバックの HTTP を許す', () => {
    expect(allowed('https://claude.ai/api/mcp/auth_callback')).toBe(true);
    expect(allowed('https://agent.meta.ai/connectors/callback')).toBe(true);
    expect(allowed('https://www.muse.ai/oauth/callback')).toBe(true);
    expect(allowed('https://www.cursor.com/agents/mcp/oauth/callback')).toBe(true);
    expect(allowed('http://localhost:53682/callback')).toBe(true);
    expect(allowed('http://127.0.0.1:8080/callback')).toBe(true);
  });

  it('許可していないホスト・ポート・スキームを拒否する', () => {
    expect(allowed('https://evil.example/callback')).toBe(false);
    expect(allowed('https://claude.ai.evil.example/callback')).toBe(false);
    expect(allowed('https://evilmuse.ai/callback')).toBe(false);
    expect(allowed('https://claude.ai:8443/callback')).toBe(false);
    // Grok Bot (Cursor) は www.cursor.com 全体ではなくコールバックの URI だけを許す
    expect(allowed('https://www.cursor.com.evil.example/agents/mcp/oauth/callback')).toBe(false);
    expect(allowed('https://evil.example/https://www.cursor.com/agents/mcp/oauth/callback')).toBe(
      false,
    );
    expect(allowed('http://www.cursor.com/agents/mcp/oauth/callback')).toBe(false);
    expect(allowed('https://www.cursor.com:8443/agents/mcp/oauth/callback')).toBe(false);
    expect(allowed('https://cursor.com/agents/mcp/oauth/callback')).toBe(false);
    expect(allowed('https://www.cursor.com/')).toBe(false);
    expect(allowed('https://www.cursor.com/agents/mcp/oauth/callback/other')).toBe(false);
    expect(
      allowed('https://www.cursor.com/agents/mcp/oauth/callback?next=https://evil.example'),
    ).toBe(false);
    expect(allowed('https://www.cursor.com/agents/mcp/oauth/callback#fragment')).toBe(false);
    expect(allowed('https://user@www.cursor.com/agents/mcp/oauth/callback')).toBe(false);
    // URL の正規化で同じ URI になる表記も、文字列として一致しなければ拒否する
    expect(allowed('https://www.cursor.com/agents/mcp/oauth/callback/')).toBe(false);
    expect(allowed('https://www.cursor.com:443/agents/mcp/oauth/callback')).toBe(false);
    expect(allowed('https://www.cursor.com/agents/mcp/x/../oauth/callback')).toBe(false);
    expect(allowed('https://www.cursor.com/agents/mcp/%2e/oauth/callback')).toBe(false);
    expect(allowed('https://%77ww.cursor.com/agents/mcp/oauth/callback')).toBe(false);
    expect(allowed('https://www.cursor.com/agents/mcp/oauth/callback?')).toBe(false);
    expect(allowed(' https://www.cursor.com/agents/mcp/oauth/callback\n')).toBe(false);
    expect(allowed('https://WWW.CURSOR.COM/agents/mcp/oauth/callback')).toBe(false);
    expect(allowed('http://claude.ai/callback')).toBe(false);
    expect(allowed('javascript:alert(1)')).toBe(false);
    expect(allowed('not a url')).toBe(false);
  });

  it('ユーザー情報部でホストを偽装した URI を拒否する', () => {
    expect(allowed('http://localhost:80@evil.example/callback')).toBe(false);
    expect(allowed('https://claude.ai@evil.example/callback')).toBe(false);
  });
});

describe.each([
  ['DynamoDbStore', (now: () => number) => new DynamoDbStore(new FakeDynamoDb(), 'table', now)],
  ['MemoryStore', (now: () => number) => new MemoryStore(now)],
] as const)('%s', (_name, createStore: (now: () => number) => OAuthStore) => {
  it('保存した値を読み出せ、期限が過ぎたら無いものとして扱う', async () => {
    let now = 1_000_000;
    const store = createStore(() => now);
    await store.put('code#abc', { used: false }, 60);
    expect(await store.get<unknown>('code#abc')).toEqual({ used: false });
    now += 60_000;
    expect(await store.get('code#abc')).toBeNull();
  });

  it('take は 1 回だけ値を返す', async () => {
    const store = createStore(Date.now);
    await store.put('code#abc', 'value', 60);
    expect(await store.take<string>('code#abc')).toBe('value');
    expect(await store.take('code#abc')).toBeNull();
  });

  it('同時に take しても値を返すのは 1 回だけ', async () => {
    const store = createStore(Date.now);
    await store.put('code#abc', 'value', 60);
    const results = await Promise.all([store.take('code#abc'), store.take('code#abc')]);
    expect(results.filter((value) => value !== null)).toEqual(['value']);
  });

  it('replace は保存されている値が期待どおりのときだけ置き換える', async () => {
    const store = createStore(Date.now);
    await store.put('grant#g', { refreshHash: 'a' }, 60);
    const current = await store.get('grant#g');
    expect(await store.replace('grant#g', current, { refreshHash: 'b' }, 60)).toBe(true);
    // 同じ値を元に 2 回目の入れ替え (同時に来た更新) は通さない
    expect(await store.replace('grant#g', current, { refreshHash: 'c' }, 60)).toBe(false);
    expect(await store.get<unknown>('grant#g')).toEqual({ refreshHash: 'b' });
  });
});

const COGNITO_ISSUER = 'https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_test';

/** Cognito のトークンエンドポイントの代わり。受けたリクエストを記録する */
const createFakeCognito = (clock: () => number) => {
  const requests: URLSearchParams[] = [];
  const idToken = (claims: Record<string, unknown> = {}) => {
    const payload = {
      iss: COGNITO_ISSUER,
      aud: 'cognito-client',
      sub: 'user-1',
      exp: Math.floor(clock() / 1000) + 3600,
      ...claims,
    };
    return `e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
  };
  let codeResponse = () =>
    Response.json({
      access_token: 'cognito-access',
      id_token: idToken(),
      refresh_token: 'cognito-refresh',
    });
  let refreshResponse = () =>
    Response.json({ access_token: 'cognito-access', id_token: idToken() });
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url !== `${COGNITO_DOMAIN}/oauth2/token`) {
      throw new Error(`unexpected fetch: ${url}`);
    }
    expect(new Headers(init?.headers).get('authorization')).toBe(
      `Basic ${Buffer.from('cognito-client:cognito-secret').toString('base64')}`,
    );
    const params = new URLSearchParams(init?.body as URLSearchParams);
    requests.push(params);
    return params.get('grant_type') === 'authorization_code' ? codeResponse() : refreshResponse();
  }) as typeof globalThis.fetch;
  return {
    fetch,
    requests,
    idToken,
    respondToCode: (respond: () => Response) => {
      codeResponse = respond;
    },
    respondToRefresh: (respond: () => Response) => {
      refreshResponse = respond;
    },
  };
};

const createTestServer = () => {
  let now = Date.now();
  const clock = () => now;
  const cognito = createFakeCognito(clock);
  const oauth = createOAuth({
    baseUrl: BASE_URL,
    resourcePath: '/auth/mcp',
    cognito: {
      domainUrl: COGNITO_DOMAIN,
      issuer: COGNITO_ISSUER,
      clientId: 'cognito-client',
      clientSecret: 'cognito-secret',
    },
    keys: deriveKeys('test-secret'),
    // JSON の往復まで通すため、メモリではなく DynamoDB 実装を使う
    store: new DynamoDbStore(new FakeDynamoDb(), 'table', clock),
    redirectUriPolicy: DEFAULT_REDIRECT_URI_POLICY,
    accessTokenTtlSeconds: ACCESS_TOKEN_TTL_SECONDS,
    sessionTtlSeconds: SESSION_TTL_SECONDS,
    fetch: cognito.fetch,
    now: clock,
    log: () => {},
  });
  const app = createApp({
    baseUrl: BASE_URL,
    blogApi: createFakeBlogApi().client,
    siteUrl: 'https://example.com',
    userName: 'shuntaka',
    oauth,
    log: () => {},
  });

  const register = (body: Record<string, unknown>) =>
    app.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const registerClient = async (body: Record<string, unknown> = {}) => {
    const response = await register({
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'none',
      client_name: 'test client',
      ...body,
    });
    expect(response.status).toBe(201);
    return (await response.json()) as { client_id: string; client_secret?: string };
  };
  const authorize = (params: Record<string, string>, cookie?: string) =>
    app.request(`/oauth/authorize?${new URLSearchParams(params)}`, {
      headers: cookie ? { cookie } : {},
    });
  const consent = (transactionId: string, cookie: string | undefined, action = 'approve') =>
    app.request('/oauth/consent', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(cookie && { cookie }),
      },
      body: new URLSearchParams({ transaction_id: transactionId, action }),
    });
  const callback = (params: Record<string, string>, cookie: string | undefined) =>
    app.request(`/oauth/callback?${new URLSearchParams(params)}`, {
      headers: cookie ? { cookie } : {},
    });
  const token = (params: Record<string, string>, headers: Record<string, string> = {}) =>
    app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(params),
    });
  const callTools = (accessToken: string) =>
    mcpRequest(
      app,
      '/auth/mcp',
      { method: 'tools/list' },
      { authorization: `Bearer ${accessToken}` },
    );

  /** 認可要求を始め、同意画面の transaction_id とブラウザの Cookie を受け取る */
  const startAuthorization = async (clientId: string, redirectUri = REDIRECT_URI) => {
    const verifier = randomToken();
    const response = await authorize({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: sha256(verifier),
      code_challenge_method: 'S256',
      state: 'client-state',
      scope: 'anything',
    });
    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie')?.split(';')[0] ?? '';
    const html = await response.text();
    const transactionId = html.match(/name="transaction_id" value="([^"]+)"/)?.[1] ?? '';
    return { verifier, cookie, transactionId, html, redirectUri };
  };

  /** 認可要求から、MCP クライアントが認可コードを受け取るまで */
  const obtainCode = async (clientId: string, redirectUri = REDIRECT_URI) => {
    const started = await startAuthorization(clientId, redirectUri);
    const consented = await consent(started.transactionId, started.cookie);
    expect(consented.status).toBe(303);
    const upstream = new URL(consented.headers.get('location') ?? '');
    const returned = await callback(
      { code: 'cognito-code', state: upstream.searchParams.get('state') ?? '' },
      started.cookie,
    );
    expect(returned.status).toBe(302);
    const location = new URL(returned.headers.get('location') ?? '');
    return { ...started, upstream, location, code: location.searchParams.get('code') ?? '' };
  };

  const exchangeCode = (
    clientId: string,
    obtained: { code: string; verifier: string; redirectUri: string },
    headers: Record<string, string> = {},
  ) =>
    token(
      {
        grant_type: 'authorization_code',
        client_id: clientId,
        code: obtained.code,
        code_verifier: obtained.verifier,
        redirect_uri: obtained.redirectUri,
      },
      headers,
    );

  /** ログインからトークン発行まで */
  const login = async (clientId: string, headers: Record<string, string> = {}) => {
    const response = await exchangeCode(clientId, await obtainCode(clientId), headers);
    expect(response.status).toBe(200);
    return (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      scope: string;
    };
  };

  const refresh = (clientId: string, refreshToken: string, headers: Record<string, string> = {}) =>
    token(
      { grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken },
      headers,
    );

  return {
    app,
    cognito,
    advance: (seconds: number) => {
      now += seconds * 1000;
    },
    register,
    registerClient,
    authorize,
    consent,
    callback,
    token,
    callTools,
    startAuthorization,
    obtainCode,
    exchangeCode,
    login,
    refresh,
  };
};

const errorOf = async (response: Response) => ((await response.json()) as { error: string }).error;

describe('認証ありの /auth/mcp', () => {
  it('トークンなしは 401 で、保護リソースメタデータの場所を返す', async () => {
    const { app } = createTestServer();
    const response = await mcpRequest(app, '/auth/mcp', { method: 'tools/list' });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain(
      'resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/auth/mcp"',
    );
  });

  it('メタデータで認可サーバーと DCR の登録先を公開する', async () => {
    const { app } = createTestServer();
    const resource = await (
      await app.request('/.well-known/oauth-protected-resource/auth/mcp')
    ).json();
    expect(resource.resource).toBe('https://mcp.example.com/auth/mcp');
    expect(resource.authorization_servers).toEqual(['https://mcp.example.com']);
    expect(resource.scopes_supported).toEqual([SCOPE]);

    const server = await (await app.request('/.well-known/oauth-authorization-server')).json();
    expect(server).toMatchObject({
      issuer: 'https://mcp.example.com',
      registration_endpoint: 'https://mcp.example.com/oauth/register',
      token_endpoint: 'https://mcp.example.com/oauth/token',
      code_challenge_methods_supported: ['S256'],
      scopes_supported: [SCOPE],
    });
  });

  it('DCR から Cognito ログイン、ツール呼び出し、トークン更新まで通る', async () => {
    const server = createTestServer();
    const { client_id: clientId, client_secret: clientSecret } = await server.registerClient();
    expect(clientSecret).toBeUndefined();

    const obtained = await server.obtainCode(clientId);
    // 同意画面はクリックジャッキング対策のヘッダー付き
    expect(obtained.html).toContain('test client');
    // Cognito には openid だけを、MCP サーバー自身の PKCE 付きで要求する
    expect(obtained.upstream.origin + obtained.upstream.pathname).toBe(
      `${COGNITO_DOMAIN}/oauth2/authorize`,
    );
    expect(obtained.upstream.searchParams.get('client_id')).toBe('cognito-client');
    expect(obtained.upstream.searchParams.get('scope')).toBe('openid');
    expect(obtained.upstream.searchParams.get('code_challenge_method')).toBe('S256');
    expect(obtained.upstream.searchParams.get('redirect_uri')).toBe(`${BASE_URL}/oauth/callback`);
    expect(sha256(server.cognito.requests[0]?.get('code_verifier') ?? '')).toBe(
      obtained.upstream.searchParams.get('code_challenge') ?? 'missing',
    );
    // MCP クライアントへは state と iss (RFC 9207) を付けて戻す
    expect(obtained.location.origin + obtained.location.pathname).toBe(REDIRECT_URI);
    expect(obtained.location.searchParams.get('state')).toBe('client-state');
    expect(obtained.location.searchParams.get('iss')).toBe(BASE_URL);

    const exchanged = await server.exchangeCode(clientId, obtained);
    expect(exchanged.status).toBe(200);
    const tokens = await exchanged.json();
    expect(tokens).toMatchObject({
      token_type: 'Bearer',
      scope: SCOPE,
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
    });
    expect(JSON.stringify(tokens)).not.toContain('cognito');

    const tools = await server.callTools(tokens.access_token);
    expect(tools.status).toBe(200);
    expect((await readMcpResponse(tools)).result.tools).toHaveLength(4);

    const refreshed = await server.refresh(clientId, tokens.refresh_token);
    expect(refreshed.status).toBe(200);
    expect(server.cognito.requests[1]?.get('grant_type')).toBe('refresh_token');
    expect(server.cognito.requests[1]?.get('refresh_token')).toBe('cognito-refresh');
    const next = await refreshed.json();
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    expect((await server.callTools(next.access_token)).status).toBe(200);
  });

  it('同意画面はクライアント名をエスケープし、iframe に埋め込ませない', async () => {
    const server = createTestServer();
    const { client_id: clientId } = await server.registerClient({
      client_name: '<script>alert(1)</script>',
    });
    const verifier = randomToken();
    const response = await server.authorize({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: sha256(verifier),
      code_challenge_method: 'S256',
    });
    const html = await response.text();
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    // サブドメインから書き込めないよう __Host- 付きの Cookie でブラウザに紐付ける
    expect(response.headers.get('set-cookie')).toMatch(
      /^__Host-mcp_oauth_browser=[^;]+;.*Path=\/;.*HttpOnly;.*Secure;.*SameSite=Lax/,
    );
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });
});

describe('アクセストークンとリフレッシュトークンを取り違えて使えない', () => {
  it('リフレッシュトークンを Bearer に使うと 401', async () => {
    const server = createTestServer();
    const { client_id: clientId } = await server.registerClient();
    const tokens = await server.login(clientId);
    const response = await server.callTools(tokens.refresh_token);
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('invalid_token');
  });

  it('アクセストークンをリフレッシュトークンに使うと invalid_grant', async () => {
    const server = createTestServer();
    const { client_id: clientId } = await server.registerClient();
    const tokens = await server.login(clientId);
    const response = await server.refresh(clientId, tokens.access_token);
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe('invalid_grant');
  });

  it('署名の合わないトークンと期限切れのトークンは 401', async () => {
    const server = createTestServer();
    const { client_id: clientId } = await server.registerClient();
    const tokens = await server.login(clientId);
    const [header, payload] = tokens.access_token.split('.');
    expect((await server.callTools(`${header}.${payload}.forged`)).status).toBe(401);
    server.advance(ACCESS_TOKEN_TTL_SECONDS);
    expect((await server.callTools(tokens.access_token)).status).toBe(401);
  });
});

describe('PKCE (S256) を必須にする', () => {
  it('code_challenge が無い・plain の認可要求は同意画面を出さずにエラーで戻す', async () => {
    const server = createTestServer();
    const { client_id: clientId } = await server.registerClient();
    const variants: Record<string, string>[] = [
      {},
      { code_challenge: randomToken() },
      { code_challenge: randomToken(), code_challenge_method: 'plain' },
    ];
    for (const pkce of variants) {
      const response = await server.authorize({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        state: 'client-state',
        ...pkce,
      });
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get('location') ?? '');
      expect(location.origin + location.pathname).toBe(REDIRECT_URI);
      expect(location.searchParams.get('error')).toBe('invalid_request');
      expect(location.searchParams.get('state')).toBe('client-state');
    }
  });

  it('code_verifier が無い・合わない交換は invalid_grant で、その認可コードはもう使えない', async () => {
    const server = createTestServer();
    const { client_id: clientId } = await server.registerClient();
    const missing = await server.obtainCode(clientId);
    expect(await errorOf(await server.exchangeCode(clientId, { ...missing, verifier: '' }))).toBe(
      'invalid_grant',
    );
    expect(await errorOf(await server.exchangeCode(clientId, missing))).toBe('invalid_grant');

    const wrong = await server.obtainCode(clientId);
    expect(
      await errorOf(await server.exchangeCode(clientId, { ...wrong, verifier: randomToken() })),
    ).toBe('invalid_grant');
  });
});

describe('トークンエンドポイントでクライアントを確かめる', () => {
  it('シークレットを持つクライアントは、シークレットが合わなければ invalid_client', async () => {
    const server = createTestServer();
    const { client_id: clientId, client_secret: clientSecret } = await server.registerClient({
      token_endpoint_auth_method: 'client_secret_basic',
    });
    expect(clientSecret).toBeDefined();
    const basic = (secret: string) => ({
      authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`,
    });
    const obtained = await server.obtainCode(clientId);

    const wrong = await server.exchangeCode(clientId, obtained, basic('wrong-secret'));
    expect(wrong.status).toBe(401);
    expect(await errorOf(wrong)).toBe('invalid_client');
    expect(wrong.headers.get('www-authenticate')).toContain('Basic');
    expect((await server.exchangeCode(clientId, obtained)).status).toBe(401);

    // クライアント認証の失敗では認可コードを消費しない
    const exchanged = await server.exchangeCode(clientId, obtained, basic(clientSecret ?? ''));
    expect(exchanged.status).toBe(200);
    const tokens = await exchanged.json();
    expect(
      (await server.refresh(clientId, tokens.refresh_token, basic('wrong-secret'))).status,
    ).toBe(401);
    expect(
      (await server.refresh(clientId, tokens.refresh_token, basic(clientSecret ?? ''))).status,
    ).toBe(200);
  });

  it('client_secret_post のクライアントはフォームのシークレットで認証する', async () => {
    const server = createTestServer();
    const { client_id: clientId, client_secret: clientSecret } = await server.registerClient({
      token_endpoint_auth_method: 'client_secret_post',
    });
    const obtained = await server.obtainCode(clientId);
    const response = await server.token({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret ?? '',
      code: obtained.code,
      code_verifier: obtained.verifier,
      redirect_uri: obtained.redirectUri,
    });
    expect(response.status).toBe(200);
  });

  it('リフレッシュトークンは発行先とは別のクライアントでは使えない', async () => {
    const server = createTestServer();
    const { client_id: owner } = await server.registerClient();
    const { client_id: other } = await server.registerClient();
    const tokens = await server.login(owner);
    const stolen = await server.refresh(other, tokens.refresh_token);
    expect(stolen.status).toBe(400);
    expect(await errorOf(stolen)).toBe('invalid_grant');
    expect((await server.refresh(owner, tokens.refresh_token)).status).toBe(200);
  });

  it('登録されていない client_id は invalid_client', async () => {
    const server = createTestServer();
    const response = await server.refresh('unknown-client', 'grant.secret');
    expect(response.status).toBe(401);
    expect(await errorOf(response)).toBe('invalid_client');
  });
});

describe('redirect_uri を認可要求と照合する', () => {
  it('交換時の redirect_uri が認可要求と違えば invalid_grant', async () => {
    const server = createTestServer();
    const otherRedirectUri = 'http://127.0.0.1:53682/callback';
    const { client_id: clientId } = await server.registerClient({
      redirect_uris: [REDIRECT_URI, otherRedirectUri],
    });
    for (const redirectUri of [otherRedirectUri, 'https://evil.example/cb', '']) {
      const obtained = await server.obtainCode(clientId);
      const response = await server.exchangeCode(clientId, { ...obtained, redirectUri });
      expect(await errorOf(response)).toBe('invalid_grant');
    }
  });

  it('登録と違う戻り先や未登録のクライアントの認可要求は、リダイレクトせずにエラー画面を出す', async () => {
    const server = createTestServer();
    const { client_id: clientId } = await server.registerClient();
    const pkce = { code_challenge: sha256(randomToken()), code_challenge_method: 'S256' };
    for (const params of [
      { client_id: clientId, redirect_uri: 'https://claude.ai/api/mcp/auth_callback' },
      { client_id: 'unknown-client', redirect_uri: REDIRECT_URI },
    ]) {
      const response = await server.authorize({ response_type: 'code', ...params, ...pkce });
      expect(response.status).toBe(400);
      expect(response.headers.get('location')).toBeNull();
    }
  });
});

describe('同意と Cognito からの戻りを認可要求を始めたブラウザに紐付ける', () => {
  it('Cookie の無い・違うブラウザからの同意は 403', async () => {
    const server = createTestServer();
    const { client_id: clientId } = await server.registerClient();
    const started = await server.startAuthorization(clientId);
    const other = await server.startAuthorization(clientId);
    expect((await server.consent(started.transactionId, undefined)).status).toBe(403);
    expect((await server.consent(started.transactionId, other.cookie)).status).toBe(403);
    expect((await server.consent(started.transactionId, started.cookie)).status).toBe(303);
  });

  it('同意していない・Cookie の違う Cognito からの戻りは受け付けない', async () => {
    const server = createTestServer();
    const { client_id: clientId } = await server.registerClient();
    const notConsented = await server.startAuthorization(clientId);
    expect(
      (await server.callback({ code: 'c', state: notConsented.transactionId }, notConsented.cookie))
        .status,
    ).toBe(400);

    const started = await server.startAuthorization(clientId);
    const other = await server.startAuthorization(clientId);
    await server.consent(started.transactionId, started.cookie);
    expect(
      (await server.callback({ code: 'c', state: started.transactionId }, other.cookie)).status,
    ).toBe(403);
    expect(server.cognito.requests).toHaveLength(0);
  });

  it('拒否すると access_denied で戻す', async () => {
    const server = createTestServer();
    const { client_id: clientId } = await server.registerClient();
    const started = await server.startAuthorization(clientId);
    const response = await server.consent(started.transactionId, started.cookie, 'deny');
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('state')).toBe('client-state');
  });
});

describe('認可コードとリフレッシュトークンの使い回し', () => {
  it('認可コードは 1 回しか交換できない', async () => {
    const server = createTestServer();
    const { client_id: clientId } = await server.registerClient();
    const obtained = await server.obtainCode(clientId);
    expect((await server.exchangeCode(clientId, obtained)).status).toBe(200);
    expect(await errorOf(await server.exchangeCode(clientId, obtained))).toBe('invalid_grant');
  });

  it('応答を受け取れずに再送したら、猶予の中なら同じ後継トークンを返す', async () => {
    const server = createTestServer();
    const { client_id: clientId } = await server.registerClient();
    const first = (await server.login(clientId)).refresh_token;
    const second = (await (await server.refresh(clientId, first)).json()).refresh_token;

    // 1 回目の応答 (second) が遅れて届いても、再送の応答と同じトークンなのでどちらも使える
    const retried = await server.refresh(clientId, first);
    expect(retried.status).toBe(200);
    expect((await retried.json()).refresh_token).toBe(second);
    expect(
      server.cognito.requests.filter((r) => r.get('grant_type') === 'refresh_token'),
    ).toHaveLength(1);
    expect((await server.refresh(clientId, second)).status).toBe(200);
  });

  it('同じリフレッシュトークンで同時に更新しても、どちらにも同じ後継トークンを返す', async () => {
    const server = createTestServer();
    const { client_id: clientId } = await server.registerClient();
    const first = (await server.login(clientId)).refresh_token;
    const responses = await Promise.all([
      server.refresh(clientId, first),
      server.refresh(clientId, first),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const [a, b] = await Promise.all(responses.map((response) => response.json()));
    expect(a.refresh_token).toBe(b.refresh_token);
  });

  it('発行済みの古いトークンが猶予を過ぎて使われたら、grant ごと失効させる', async () => {
    const server = createTestServer();
    const { client_id: clientId } = await server.registerClient();
    const victim = await server.login(clientId);
    // 盗んだ側が先に更新し、現在のトークンを手にする
    const stolen = await (await server.refresh(clientId, victim.refresh_token)).json();
    server.advance(2 * 60 + 1);

    // 正規のクライアントが古いトークンを使うと、盗んだ側のトークンも止まる
    expect(await errorOf(await server.refresh(clientId, victim.refresh_token))).toBe(
      'invalid_grant',
    );
    expect(await errorOf(await server.refresh(clientId, stolen.refresh_token))).toBe(
      'invalid_grant',
    );
    expect((await server.callTools(stolen.access_token)).status).toBe(401);
  });

  it('MAC の合わないリフレッシュトークンでは grant を失効させない', async () => {
    const server = createTestServer();
    const { client_id: clientId } = await server.registerClient();
    const tokens = await server.login(clientId);
    // grant ID はアクセストークンの中身から読めるが、MAC は作れない
    const [grantId] = tokens.refresh_token.split('.');
    for (const forged of [`${grantId}.0.${randomToken()}`, `${grantId}.1.${randomToken()}`]) {
      expect(await errorOf(await server.refresh(clientId, forged))).toBe('invalid_grant');
    }
    expect((await server.refresh(clientId, tokens.refresh_token)).status).toBe(200);
  });
});

describe('ログインの有効期間', () => {
  it('Cognito がトークン更新を拒否したら invalid_grant にし、発行済みのアクセストークンも通さない', async () => {
    const server = createTestServer();
    const { client_id: clientId } = await server.registerClient();
    const tokens = await server.login(clientId);
    server.cognito.respondToRefresh(() =>
      Response.json({ error: 'invalid_grant' }, { status: 400 }),
    );
    expect(await errorOf(await server.refresh(clientId, tokens.refresh_token))).toBe(
      'invalid_grant',
    );
    expect((await server.callTools(tokens.access_token)).status).toBe(401);
  });

  it('Cognito に届かなければ 503 で、同じリフレッシュトークンで再試行できる', async () => {
    const server = createTestServer();
    const { client_id: clientId } = await server.registerClient();
    const tokens = await server.login(clientId);
    server.cognito.respondToRefresh(() => new Response('unavailable', { status: 500 }));
    const failed = await server.refresh(clientId, tokens.refresh_token);
    expect(failed.status).toBe(503);
    server.cognito.respondToRefresh(() =>
      Response.json({ access_token: 'cognito-access', id_token: server.cognito.idToken() }),
    );
    expect((await server.refresh(clientId, tokens.refresh_token)).status).toBe(200);
  });

  it('ログインから期間を過ぎたらトークン更新できない', async () => {
    const server = createTestServer();
    const { client_id: clientId } = await server.registerClient();
    const tokens = await server.login(clientId);
    server.advance(SESSION_TTL_SECONDS);
    expect(await errorOf(await server.refresh(clientId, tokens.refresh_token))).toBe(
      'invalid_grant',
    );
  });
});

describe('DCR', () => {
  it('許可していないリダイレクト先と、対応していない認証方式は登録しない', async () => {
    const server = createTestServer();
    const redirect = await server.register({
      redirect_uris: ['http://localhost:80@evil.example/callback'],
    });
    expect(redirect.status).toBe(400);
    expect(await errorOf(redirect)).toBe('invalid_redirect_uri');

    const method = await server.register({
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'private_key_jwt',
    });
    expect(method.status).toBe(400);
    expect(await errorOf(method)).toBe('invalid_client_metadata');
  });

  it('登録しただけで使われないクライアントは 1 日で消える', async () => {
    const server = createTestServer();
    const { client_id: clientId } = await server.registerClient();
    // 期限は秒単位に切り上げて保存するため、1 秒余分に進める
    server.advance(24 * 60 * 60 + 1);
    const response = await server.authorize({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: sha256(randomToken()),
      code_challenge_method: 'S256',
    });
    expect(response.status).toBe(400);
  });
});

describe('resource と Cognito の ID トークン', () => {
  it('別のリソースを指す resource は invalid_target で断る (末尾のスラッシュは同じとみなす)', async () => {
    const server = createTestServer();
    const { client_id: clientId } = await server.registerClient();
    const authorize = (resource: string) =>
      server.authorize({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        code_challenge: sha256(randomToken()),
        code_challenge_method: 'S256',
        resource,
      });
    const other = await authorize('https://other.example.com/mcp');
    expect(new URL(other.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'invalid_target',
    );
    expect((await authorize(`${BASE_URL}/auth/mcp/`)).status).toBe(200);

    const tokens = await server.login(clientId);
    const refreshed = await server.token({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: tokens.refresh_token,
      resource: 'https://other.example.com/mcp',
    });
    expect(await errorOf(refreshed)).toBe('invalid_target');
  });

  it('iss・aud・exp の合わない ID トークンではログインさせない', async () => {
    for (const claims of [
      { iss: 'https://cognito-idp.ap-northeast-1.amazonaws.com/other-pool' },
      { aud: 'other-client' },
      { exp: 0 },
    ]) {
      const server = createTestServer();
      const { client_id: clientId } = await server.registerClient();
      server.cognito.respondToCode(() =>
        Response.json({ id_token: server.cognito.idToken(claims), refresh_token: 'r' }),
      );
      const started = await server.startAuthorization(clientId);
      const consented = await server.consent(started.transactionId, started.cookie);
      const state = new URL(consented.headers.get('location') ?? '').searchParams.get('state');
      const returned = await server.callback({ code: 'c', state: state ?? '' }, started.cookie);
      const location = new URL(returned.headers.get('location') ?? '');
      expect(location.searchParams.get('error')).toBe('server_error');
      expect(location.searchParams.get('code')).toBeNull();
    }
  });
});
