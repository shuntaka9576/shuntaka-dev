import { describe, expect, it } from 'bun:test';
import { createApp } from './app.js';
import { createDevLogin } from './dev-login.js';
import { randomToken, sha256 } from './oauth/crypto.js';
import { createOAuth } from './oauth/index.js';
import { DEFAULT_REDIRECT_URI_POLICY } from './oauth/redirect-uri.js';
import { MemoryStore } from './oauth/store.js';
import { deriveKeys } from './secrets.js';
import { createFakeBlogApi, mcpRequest } from './test-helpers.js';

const BASE_URL = 'http://localhost:43008';
const REDIRECT_URI = 'http://localhost:53682/callback';

describe('ローカルの仮ログイン', () => {
  it('認可サーバーから見て Cognito と同じに振る舞い、ログインからトークン更新まで通る', async () => {
    const client = { clientId: 'local-mcp-server', clientSecret: 'local-secret' };
    const devLogin = createDevLogin({
      basePath: '/dev-login',
      issuer: `${BASE_URL}/dev-login`,
      ...client,
    });
    const app = createApp({
      baseUrl: BASE_URL,
      blogApi: createFakeBlogApi().client,
      siteUrl: 'https://example.com',
      userName: 'shuntaka',
      oauth: createOAuth({
        baseUrl: BASE_URL,
        resourcePath: '/auth/mcp',
        cognito: { domainUrl: `${BASE_URL}/dev-login`, issuer: `${BASE_URL}/dev-login`, ...client },
        keys: deriveKeys('test-secret'),
        store: new MemoryStore(),
        redirectUriPolicy: DEFAULT_REDIRECT_URI_POLICY,
        accessTokenTtlSeconds: 3600,
        sessionTtlSeconds: 86400,
        fetch: ((input: string | URL | Request, init?: RequestInit) =>
          devLogin.request(
            input instanceof Request ? input.url : input.toString(),
            init,
          )) as typeof fetch,
        log: () => {},
      }),
      log: () => {},
    });

    const { client_id: clientId } = await (
      await app.request('/oauth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none' }),
      })
    ).json();
    const verifier = randomToken();
    const authorized = await app.request(
      `/oauth/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        code_challenge: sha256(verifier),
        code_challenge_method: 'S256',
        state: 'client-state',
      })}`,
    );
    const cookie = authorized.headers.get('set-cookie')?.split(';')[0] ?? '';
    const transactionId =
      (await authorized.text()).match(/name="transaction_id" value="([^"]+)"/)?.[1] ?? '';
    const consented = await app.request('/oauth/consent', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ transaction_id: transactionId, action: 'approve' }),
    });

    // 仮ログインの画面からログインすると、認可サーバーのコールバックに戻る
    const loginPage = await devLogin.request(consented.headers.get('location') ?? '');
    const html = await loginPage.text();
    expect(html).toContain('Sign in');
    const field = (name: string) =>
      html.match(new RegExp(`name="${name}" value="([^"]*)"`))?.[1] ?? '';
    const loggedIn = await devLogin.request('/dev-login/login', {
      method: 'POST',
      body: new URLSearchParams({
        redirect_uri: field('redirect_uri'),
        state: field('state'),
        code_challenge: field('code_challenge'),
      }),
    });
    const callback = new URL(loggedIn.headers.get('location') ?? '');
    expect(callback.pathname).toBe('/oauth/callback');
    const returned = await app.request(callback.pathname + callback.search, {
      headers: { cookie },
    });
    const code = new URL(returned.headers.get('location') ?? '').searchParams.get('code') ?? '';

    const tokens = await (
      await app.request('/oauth/token', {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          code,
          code_verifier: verifier,
          redirect_uri: REDIRECT_URI,
        }),
      })
    ).json();
    const tools = await mcpRequest(
      app,
      '/auth/mcp',
      { method: 'tools/list' },
      { authorization: `Bearer ${tokens.access_token}` },
    );
    expect(tools.status).toBe(200);
    const refreshed = await app.request('/oauth/token', {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: tokens.refresh_token,
      }),
    });
    expect(refreshed.status).toBe(200);
  });
});
