import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { createApp } from './app.js';
import { DynamoDbTokenStorage } from './dynamodb-token-storage.js';
import { createOAuth, DEFAULT_REDIRECT_URI_POLICY, isAllowedRedirectUri } from './oauth.js';
import { deriveKeys } from './secrets.js';
import { FakeDynamoDb, createFakeBlogApi, mcpRequest, readMcpResponse } from './test-helpers.js';

describe('isAllowedRedirectUri', () => {
  const allowed = (uri: string) => isAllowedRedirectUri(uri, DEFAULT_REDIRECT_URI_POLICY);

  it('許可したホストの HTTPS とループバックの HTTP を許す', () => {
    expect(allowed('https://claude.ai/api/mcp/auth_callback')).toBe(true);
    expect(allowed('https://agent.meta.ai/connectors/callback')).toBe(true);
    expect(allowed('https://www.muse.ai/oauth/callback')).toBe(true);
    expect(allowed('http://localhost:53682/callback')).toBe(true);
    expect(allowed('http://127.0.0.1:8080/callback')).toBe(true);
  });

  it('許可していないホスト・ポート・スキームを拒否する', () => {
    expect(allowed('https://evil.example/callback')).toBe(false);
    expect(allowed('https://claude.ai.evil.example/callback')).toBe(false);
    expect(allowed('https://evilmuse.ai/callback')).toBe(false);
    expect(allowed('https://claude.ai:8443/callback')).toBe(false);
    expect(allowed('http://claude.ai/callback')).toBe(false);
    expect(allowed('javascript:alert(1)')).toBe(false);
    expect(allowed('not a url')).toBe(false);
  });

  it('ユーザー情報部でホストを偽装した URI を拒否する', () => {
    // fastmcp の glob (`http://localhost:*`) には一致してしまう形
    expect(allowed('http://localhost:80@evil.example/callback')).toBe(false);
    expect(allowed('https://claude.ai@evil.example/callback')).toBe(false);
  });
});

describe('DynamoDbTokenStorage', () => {
  it('保存した値を読み出せ、期限が過ぎたら無いものとして扱う', async () => {
    let now = 1_000_000;
    const storage = new DynamoDbTokenStorage(new FakeDynamoDb(), 'table', () => now);
    await storage.save('code:abc', { used: false }, 60);
    expect(await storage.get('code:abc')).toEqual({ used: false });
    now += 61_000;
    expect(await storage.get('code:abc')).toBeNull();
  });

  it('take は 1 回だけ値を返す', async () => {
    const storage = new DynamoDbTokenStorage(new FakeDynamoDb(), 'table');
    await storage.save('mapping:jti', 'encrypted');
    expect(await storage.take('mapping:jti')).toBe('encrypted');
    expect(await storage.take('mapping:jti')).toBeNull();
  });
});

describe('認証ありの /auth/mcp', () => {
  const cognitoDomain = 'https://auth.example.com';
  const redirectUri = 'http://localhost:53682/callback';
  const realFetch = globalThis.fetch;
  let cognitoRequests: URLSearchParams[];
  let oauth: ReturnType<typeof createOAuth>;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    cognitoRequests = [];
    // OAuthProxy は Cognito のトークンエンドポイントをグローバルの fetch で呼ぶ
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url !== `${cognitoDomain}/oauth2/token`) {
        throw new Error(`unexpected fetch: ${url}`);
      }
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe(
        `Basic ${Buffer.from('cognito-client:cognito-secret').toString('base64')}`,
      );
      cognitoRequests.push(new URLSearchParams(init?.body as string));
      return Response.json({
        access_token: `cognito-access-${cognitoRequests.length}`,
        id_token: 'cognito-id',
        refresh_token: 'cognito-refresh',
        expires_in: 3600,
        token_type: 'Bearer',
      });
    }) as typeof fetch;

    oauth = createOAuth({
      baseUrl: 'https://mcp.example.com',
      resourcePath: '/auth/mcp',
      cognito: {
        domainUrl: cognitoDomain,
        clientId: 'cognito-client',
        clientSecret: 'cognito-secret',
      },
      keys: deriveKeys('test-secret'),
      // 暗号化した値の JSON 往復 (Date が文字列になる) まで通すため、メモリではなく DynamoDB 実装を使う
      tokenStorage: new DynamoDbTokenStorage(new FakeDynamoDb(), 'table'),
      redirectUriPolicy: DEFAULT_REDIRECT_URI_POLICY,
      refreshTokenTtlSeconds: 30 * 24 * 60 * 60,
    });
    app = createApp({
      baseUrl: 'https://mcp.example.com',
      blogApi: createFakeBlogApi().client,
      siteUrl: 'https://example.com',
      userName: 'shuntaka',
      oauth,
      log: () => {},
    });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    oauth.proxy.destroy();
  });

  it('トークンなしは 401 で、保護リソースメタデータの場所を返す', async () => {
    const response = await mcpRequest(app, '/auth/mcp', { method: 'tools/list' });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain(
      'resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/auth/mcp"',
    );
  });

  it('メタデータで認可サーバーと DCR の登録先を公開する', async () => {
    const resource = await (
      await app.request('/.well-known/oauth-protected-resource/auth/mcp')
    ).json();
    expect(resource.resource).toBe('https://mcp.example.com/auth/mcp');
    expect(resource.authorization_servers).toEqual(['https://mcp.example.com']);

    const server = await (await app.request('/.well-known/oauth-authorization-server')).json();
    expect(server).toMatchObject({
      issuer: 'https://mcp.example.com',
      registration_endpoint: 'https://mcp.example.com/oauth/register',
      token_endpoint: 'https://mcp.example.com/oauth/token',
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['openid'],
    });
  });

  it('許可していないリダイレクト先の DCR を拒否する', async () => {
    const response = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://localhost:80@evil.example/callback'] }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('invalid_redirect_uri');
  });

  it('DCR から Cognito ログイン、ツール呼び出し、トークン更新まで通る', async () => {
    // 1. DCR
    const registered = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: 'none',
        client_name: 'test client',
      }),
    });
    expect(registered.status).toBe(201);
    const { client_id: clientId } = await registered.json();

    // 2. 認可要求 (PKCE S256)。同意画面が返る
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authorize = await app.request(
      `/oauth/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: 'client-state',
        scope: 'mcp:tools',
      })}`,
    );
    expect(authorize.status).toBe(200);
    expect(authorize.headers.get('x-frame-options')).toBe('DENY');
    const transactionId = (await authorize.text()).match(
      /name="transaction_id" value="([^"]+)"/,
    )?.[1];
    expect(transactionId).toBeDefined();

    // 3. 同意すると Cognito の managed login へ。スコープは openid に置き換わる
    const consent = await app.request('/oauth/consent', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ transaction_id: transactionId ?? '', action: 'approve' }),
    });
    expect(consent.status).toBe(302);
    const upstream = new URL(consent.headers.get('location') ?? '');
    expect(upstream.origin + upstream.pathname).toBe(`${cognitoDomain}/oauth2/authorize`);
    expect(upstream.searchParams.get('client_id')).toBe('cognito-client');
    expect(upstream.searchParams.get('scope')).toBe('openid');
    expect(upstream.searchParams.get('redirect_uri')).toBe(
      'https://mcp.example.com/oauth/callback',
    );

    // 4. Cognito から戻ると、MCP クライアントへ認可コードを渡す
    const callback = await app.request(
      `/oauth/callback?code=cognito-code&state=${upstream.searchParams.get('state')}`,
    );
    expect(callback.status).toBe(302);
    const clientRedirect = new URL(callback.headers.get('location') ?? '');
    expect(clientRedirect.origin + clientRedirect.pathname).toBe(redirectUri);
    expect(clientRedirect.searchParams.get('state')).toBe('client-state');
    expect(cognitoRequests[0]?.get('grant_type')).toBe('authorization_code');

    // 5. トークン交換。Cognito のトークンではなく、このサーバーが署名した JWT が返る
    const token = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code: clientRedirect.searchParams.get('code') ?? '',
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }),
    });
    expect(token.status).toBe(200);
    const tokens = await token.json();
    expect(tokens.access_token).not.toContain('cognito');
    expect(tokens.refresh_token).toBeDefined();

    // 6. ツールを呼べる
    const tools = await mcpRequest(
      app,
      '/auth/mcp',
      { method: 'tools/list' },
      { authorization: `Bearer ${tokens.access_token}` },
    );
    expect(tools.status).toBe(200);
    expect((await readMcpResponse(tools)).result.tools).toHaveLength(4);

    // 7. トークン更新。使ったリフレッシュトークンはもう使えない
    const refresh = (refreshToken: string) =>
      app.request('/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: clientId,
          refresh_token: refreshToken,
          scope: 'openid',
        }),
      });
    const refreshed = await refresh(tokens.refresh_token);
    expect(refreshed.status).toBe(200);
    expect(cognitoRequests[1]?.get('grant_type')).toBe('refresh_token');
    expect(cognitoRequests[1]?.has('scope')).toBe(false);
    const reused = await refresh(tokens.refresh_token);
    expect(reused.status).toBe(400);
    expect((await reused.json()).error).toBe('invalid_grant');
  });

  it('署名の合わないトークンは 401 にする', async () => {
    const response = await mcpRequest(
      app,
      '/auth/mcp',
      { method: 'tools/list' },
      { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJqdGkiOiJ4In0.invalid' },
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('invalid_token');
  });
});
