import { Hono } from 'hono';
import { randomToken, safeEqual, sha256 } from './oauth/crypto.js';
import { brandedPage, escapeHtml } from './oauth/pages.js';

// ローカル実行 (src/dev.ts) で Cognito の代わりをする仮ログイン。AWS の認証なしで認証ありの /auth/mcp を試せるようにする。
// managed login の画面の代わりに「Sign in」ボタンだけの画面を出し、決まったユーザー (local-user) としてログインさせる。
// 認可サーバー (src/oauth) から見た振る舞いは Cognito と同じにしてある
// (/oauth2/authorize と /oauth2/token、認可コード + PKCE S256、client_secret_basic、リフレッシュ)。
// 本番のバンドル (src/index.ts) からは読み込まない
export const LOCAL_USER = 'local-user';

export const createDevLogin = (options: {
  basePath: string;
  /** ID トークンの iss。認可サーバーに渡す CognitoConfig.issuer と揃える */
  issuer: string;
  clientId: string;
  clientSecret: string;
}) => {
  const codes = new Map<string, { redirectUri: string; codeChallenge: string }>();
  const idToken = () => {
    const claims = {
      iss: options.issuer,
      aud: options.clientId,
      sub: LOCAL_USER,
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    return `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.local`;
  };
  const refreshTokens = new Set<string>();
  const app = new Hono().basePath(options.basePath);
  const tokenError = (description: string) =>
    Response.json({ error: 'invalid_grant', error_description: description }, { status: 400 });

  app.get('/oauth2/authorize', (c) => {
    const query = c.req.query();
    if (
      query.client_id !== options.clientId ||
      query.response_type !== 'code' ||
      query.code_challenge_method !== 'S256' ||
      !query.code_challenge ||
      !query.redirect_uri
    ) {
      return c.text('invalid authorization request', 400);
    }
    const hidden = (['redirect_uri', 'state', 'code_challenge'] as const)
      .map(
        (name) => `<input type="hidden" name="${name}" value="${escapeHtml(query[name] ?? '')}">`,
      )
      .join('\n');
    return c.html(
      brandedPage(
        'Local sign-in',
        `<h1>Local sign-in</h1>
<p>This page stands in for Cognito when running locally. You will be signed in as <code>${LOCAL_USER}</code>.</p>
<form method="post" action="${options.basePath}/login">
${hidden}
<button type="submit" class="primary">Sign in</button>
</form>`,
      ),
    );
  });

  app.post('/login', async (c) => {
    const form = await c.req.parseBody();
    const field = (name: string) => {
      const value = form[name];
      return typeof value === 'string' ? value : '';
    };
    const code = randomToken();
    codes.set(code, { redirectUri: field('redirect_uri'), codeChallenge: field('code_challenge') });
    const url = new URL(field('redirect_uri'));
    url.searchParams.set('code', code);
    url.searchParams.set('state', field('state'));
    return c.redirect(url.toString(), 303);
  });

  app.post('/oauth2/token', async (c) => {
    const expected = `Basic ${Buffer.from(`${options.clientId}:${options.clientSecret}`).toString('base64')}`;
    if (!safeEqual(c.req.header('authorization') ?? '', expected)) {
      return Response.json({ error: 'invalid_client' }, { status: 401 });
    }
    const params = new URLSearchParams(await c.req.text());
    if (params.get('grant_type') === 'authorization_code') {
      const code = codes.get(params.get('code') ?? '');
      codes.delete(params.get('code') ?? '');
      if (
        !code ||
        code.redirectUri !== params.get('redirect_uri') ||
        sha256(params.get('code_verifier') ?? '') !== code.codeChallenge
      ) {
        return tokenError('invalid authorization code');
      }
      const refreshToken = randomToken();
      refreshTokens.add(refreshToken);
      return c.json({
        id_token: idToken(),
        access_token: randomToken(),
        refresh_token: refreshToken,
        expires_in: 3600,
        token_type: 'Bearer',
      });
    }
    if (
      params.get('grant_type') === 'refresh_token' &&
      refreshTokens.has(params.get('refresh_token') ?? '')
    ) {
      return c.json({
        id_token: idToken(),
        access_token: randomToken(),
        expires_in: 3600,
        token_type: 'Bearer',
      });
    }
    return tokenError('invalid refresh token');
  });

  return app;
};
