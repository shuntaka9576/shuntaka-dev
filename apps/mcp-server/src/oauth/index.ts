import {
  type AuthInfo,
  buildOAuthProtectedResourceMetadata,
  getOAuthProtectedResourceMetadataUrl,
  type OAuthMetadata,
  OAuthError,
  OAuthErrorCode,
  requireBearerAuth,
} from '@modelcontextprotocol/server';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { type Log, stdoutLog } from '../observability.js';
import { type CognitoConfig, CognitoTokenError, createCognitoClient } from './cognito.js';
import {
  decrypt,
  encrypt,
  hmacSha256,
  randomToken,
  safeEqual,
  sha256,
  signAccessToken,
  verifyAccessToken as verifyAccessTokenJwt,
} from './crypto.js';
import { consentPage, errorPage } from './pages.js';
import { isAllowedRedirectUri, type RedirectUriPolicy } from './redirect-uri.js';
import type { OAuthStore } from './store.js';

// 認証ありのエンドポイント用の認可サーバー。MCP クライアントには DCR・認可・トークンをこのサーバーが提供し、
// ログインだけを Cognito (admin のユーザープール) に任せる。MCP クライアントに渡すのはこのサーバーが署名した
// アクセストークンと不透明なリフレッシュトークンで、Cognito のトークンはサーバーの外に出さない。
//
// 保証すること (src/oauth/oauth.test.ts で 1 つずつ確かめている)
// - PKCE (S256) を必須にする。plain や code_challenge なしの認可要求は通さない
// - 認可コードは 1 回だけ、発行先のクライアントが、認可要求と同じ redirect_uri と正しい code_verifier を添えたときだけ交換できる
// - シークレットを持つクライアントはトークンエンドポイントでシークレットを照合する
// - リフレッシュトークンは発行先のクライアントしか使えず、使うたびに新しいものに替わる。発行済みの古いものが
//   猶予を過ぎて使われたら、盗まれたとみなして grant ごと失効させる (RFC 9700 4.14.2)
// - アクセストークンとリフレッシュトークンは形式が違い、取り違えて使えない
// - 同意画面と Cognito からの戻りは、認可要求を始めたブラウザでしか進められない (Cookie で紐付ける)
// - すべての状態に期限を付ける。DCR で登録しただけで使われないクライアントは 1 日で消える
// - 認可要求とトークン要求の resource (RFC 8707) は、指定されたらこの MCP エンドポイントでなければ断る

/** MCP クライアントに許すのは公開記事の読み取りだけ。要求されたスコープにかかわらずこれを付ける */
export const SCOPE = 'blog:read';

const TRANSACTION_TTL_SECONDS = 10 * 60;
const AUTHORIZATION_CODE_TTL_SECONDS = 5 * 60;
/** DCR で登録しただけのクライアントを残す期間。トークンを発行したらセッションの長さまで延ばす */
const UNUSED_CLIENT_TTL_SECONDS = 24 * 60 * 60;
/**
 * 新しいリフレッシュトークンを受け取れなかったクライアントが、直前のリフレッシュトークンで再送できる猶予。
 * 猶予の中の再送には同じ後継トークンを返す。記事の検証では、トークン更新の応答がコールドスタートと重なって
 * MCP クライアントに届かず再認証になった
 */
const REFRESH_RETRY_GRACE_SECONDS = 2 * 60;
const MAX_BODY_BYTES = 16 * 1024;

/** randomToken() の値と S256 の code_challenge (どちらも 256 bit の base64url) */
const BASE64URL_256BIT = /^[A-Za-z0-9_-]{43}$/;
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

interface ClientRecord {
  redirectUris: string[];
  tokenEndpointAuthMethod: 'none' | 'client_secret_basic' | 'client_secret_post';
  /** none のクライアントは持たない */
  clientSecretHash?: string;
  clientName?: string;
}

interface TransactionRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  /** 認可要求を始めたブラウザの Cookie のハッシュ */
  browserHash: string;
  /** Cognito への認可要求に使う PKCE の code_verifier */
  upstreamVerifier: string;
  consented: boolean;
  expiresAt: number;
}

interface CodeRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  subject: string;
  /** 暗号化した Cognito のリフレッシュトークン */
  upstreamRefreshToken: string;
}

/** 1 回のログインで MCP クライアントに与えた権限。リフレッシュトークンを替えても同じ grant が続く */
interface GrantRecord {
  clientId: string;
  subject: string;
  upstreamRefreshToken: string;
  /** 現在のリフレッシュトークンの世代。トークンを更新するたびに 1 つ進む */
  generation: number;
  /** generation を進めた時刻。直前の世代の再送を受け付ける猶予はここから数える */
  rotatedAt: number;
  /** ログインから sessionTtlSeconds 後。Cognito のリフレッシュトークンの期限と同じで、更新しても延びない */
  expiresAt: number;
}

const clientKey = (clientId: string) => `client#${clientId}`;
const transactionKey = (transactionId: string) => `txn#${transactionId}`;
const codeKey = (code: string) => `code#${sha256(code)}`;
const grantKey = (grantId: string) => `grant#${grantId}`;

/** RFC 6749 5.2 / RFC 7591 3.2.2 のエラー。JSON で返す */
class OAuthEndpointError extends Error {
  constructor(
    readonly code: string,
    readonly description: string,
    readonly status: 400 | 401 | 413 | 503 = 400,
    readonly headers: Record<string, string> = {},
  ) {
    super(description);
  }

  toResponse() {
    return Response.json(
      { error: this.code, error_description: this.description },
      { status: this.status, headers: this.headers },
    );
  }
}

const invalidGrant = (description: string) => new OAuthEndpointError('invalid_grant', description);

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
  try {
    return {
      clientId: decodeURIComponent(decoded.slice(0, separator)),
      clientSecret: decodeURIComponent(decoded.slice(separator + 1)),
    };
  } catch {
    return undefined;
  }
};

const registrationSchema = z.object({
  redirect_uris: z.array(z.string()).min(1).max(10),
  token_endpoint_auth_method: z
    .enum(['none', 'client_secret_basic', 'client_secret_post'])
    .default('client_secret_basic'),
  grant_types: z.array(z.enum(['authorization_code', 'refresh_token'])).optional(),
  response_types: z.array(z.literal('code')).optional(),
  client_name: z.string().max(200).optional(),
});

export interface OAuthKeys {
  /** アクセストークン (HS256) の署名鍵 */
  accessTokenKey: Buffer;
  /** リフレッシュトークンの MAC の鍵 */
  refreshTokenKey: Buffer;
  /** Cognito のリフレッシュトークンを保存するときの暗号鍵 (AES-256) */
  encryptionKey: Buffer;
}

export interface OAuthOptions {
  /** 認可サーバーの issuer を兼ねる。例: https://mcp.shuntaka.dev */
  baseUrl: string;
  /** 認証ありの MCP エンドポイントのパス (例: /auth/mcp)。アクセストークンの宛先 (aud) になる */
  resourcePath: string;
  cognito: CognitoConfig;
  keys: OAuthKeys;
  store: OAuthStore;
  redirectUriPolicy: RedirectUriPolicy;
  /** MCP クライアントに渡すアクセストークンの寿命 */
  accessTokenTtlSeconds: number;
  /** ログインの有効期間。Cognito のリフレッシュトークンの期限と揃える */
  sessionTtlSeconds: number;
  fetch?: typeof fetch;
  now?: () => number;
  log?: Log;
}

export const createOAuth = (options: OAuthOptions) => {
  const { baseUrl, keys, store } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? stdoutLog;
  const resourceUrl = new URL(options.resourcePath, baseUrl);
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl);
  const cognito = createCognitoClient({
    ...options.cognito,
    redirectUri: `${baseUrl}/oauth/callback`,
    fetch: options.fetch ?? globalThis.fetch,
    now,
  });

  const authorizationServerMetadata: OAuthMetadata = {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    registration_endpoint: `${baseUrl}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
    scopes_supported: [SCOPE],
    authorization_response_iss_parameter_supported: true,
  };
  const protectedResourceMetadata = buildOAuthProtectedResourceMetadata({
    oauthMetadata: authorizationServerMetadata,
    resourceServerUrl: resourceUrl,
    scopesSupported: [SCOPE],
    resourceName: 'shuntaka.dev blog',
  });

  const remainingSeconds = (expiresAt: number) => Math.ceil((expiresAt - now()) / 1000);

  /** RFC 8707 の resource。指定されたものはすべてこの MCP エンドポイントを指していること (末尾のスラッシュは無視) */
  const isOwnResource = (resources: string[]) =>
    resources.every((resource) => resource.replace(/\/$/, '') === resourceUrl.href);

  /** 認可応答の戻り先 (RFC 9207 の iss を付ける) */
  const clientRedirect = (redirectUri: string, params: Record<string, string | undefined>) => {
    const url = new URL(redirectUri);
    for (const [name, value] of Object.entries(params)) {
      if (value !== undefined) {
        url.searchParams.set(name, value);
      }
    }
    url.searchParams.set('iss', baseUrl);
    return url.toString();
  };

  // 認可要求を始めたブラウザに Cookie を持たせ、同意と Cognito からの戻りでそのブラウザかを確かめる。
  // 他人に送りつけた同意フォームや Cognito のログイン URL では手続きを進められない。
  // HTTPS では __Host- を付け、兄弟のサブドメイン (admin・images) から Cookie を書き込まれて紐付けを偽られないようにする
  // (ローカルの http では __Host- を使えないため付けない)
  const secureCookie = baseUrl.startsWith('https:');
  const browserCookie = secureCookie ? '__Host-mcp_oauth_browser' : 'mcp_oauth_browser';
  const bindBrowser = (c: Context) => {
    const existing = getCookie(c, browserCookie);
    const value =
      existing !== undefined && BASE64URL_256BIT.test(existing) ? existing : randomToken();
    setCookie(c, browserCookie, value, {
      path: '/',
      httpOnly: true,
      secure: secureCookie,
      // Cognito からの戻り (別サイトからのトップレベルの GET) でも送られるよう Lax にする
      sameSite: 'Lax',
      maxAge: TRANSACTION_TTL_SECONDS,
    });
    return sha256(value);
  };
  const isSameBrowser = (c: Context, transaction: TransactionRecord) => {
    const value = getCookie(c, browserCookie);
    return value !== undefined && safeEqual(sha256(value), transaction.browserHash);
  };

  // RFC 6749 2.3 / 3.2.1。シークレットを持つクライアントは Basic とフォームのどちらで送ってきても照合する
  const authenticateClient = async (header: string | undefined, params: URLSearchParams) => {
    const basic = parseBasicAuth(header);
    const formClientId = params.get('client_id');
    const formSecret = params.get('client_secret');
    if (
      basic &&
      (formSecret !== null || (formClientId !== null && formClientId !== basic.clientId))
    ) {
      throw new OAuthEndpointError('invalid_request', 'Use only one client authentication method');
    }
    const invalidClient = () =>
      new OAuthEndpointError(
        'invalid_client',
        'Client authentication failed',
        401,
        basic ? { 'WWW-Authenticate': 'Basic realm="oauth"' } : {},
      );
    const clientId = basic?.clientId ?? formClientId;
    const client = clientId ? await store.get<ClientRecord>(clientKey(clientId)) : null;
    if (!clientId || !client) {
      throw invalidClient();
    }
    if (client.clientSecretHash !== undefined) {
      const secret = basic?.clientSecret ?? formSecret;
      if (!secret || !safeEqual(sha256(secret), client.clientSecretHash)) {
        throw invalidClient();
      }
    }
    return { clientId, client };
  };

  const issueTokens = (grantId: string, grant: GrantRecord, refreshToken: string) => {
    const issuedAt = now();
    const iat = Math.floor(issuedAt / 1000);
    // アクセストークンもログインの有効期間を超えさせない
    const exp = Math.floor(
      Math.min(issuedAt + options.accessTokenTtlSeconds * 1000, grant.expiresAt) / 1000,
    );
    return {
      access_token: signAccessToken(keys.accessTokenKey, {
        iss: baseUrl,
        aud: resourceUrl.href,
        sub: grant.subject,
        client_id: grant.clientId,
        scope: SCOPE,
        gid: grantId,
        iat,
        exp,
        jti: randomToken(16),
      }),
      token_type: 'Bearer',
      expires_in: exp - iat,
      refresh_token: refreshToken,
      scope: SCOPE,
    };
  };

  // リフレッシュトークンは `<grant ID>.<世代>.<MAC>`。MAC で発行済みのものかを確かめられるため、grant には世代だけを持つ。
  // 同じ世代のトークンはいつ作っても同じ値になるため、再送や同時の更新には同じ後継トークンを返せる
  const refreshTokenFor = (grantId: string, generation: number) => {
    const body = `${grantId}.${generation}`;
    return `${body}.${hmacSha256(keys.refreshTokenKey, body)}`;
  };
  const parseRefreshToken = (token: string) => {
    const match = /^([A-Za-z0-9_-]{22})\.(0|[1-9][0-9]{0,8})\.[A-Za-z0-9_-]{43}$/.exec(token);
    if (!match?.[1] || !match[2]) {
      return null;
    }
    const grantId = match[1];
    const generation = Number(match[2]);
    return safeEqual(token, refreshTokenFor(grantId, generation)) ? { grantId, generation } : null;
  };

  const exchangeAuthorizationCode = async (
    clientId: string,
    client: ClientRecord,
    params: URLSearchParams,
  ) => {
    const code = params.get('code');
    if (!code) {
      throw new OAuthEndpointError('invalid_request', 'code is required');
    }
    // 交換に失敗しても認可コードは使用済みになる (同じコードで何度も試させない)
    const record = await store.take<CodeRecord>(codeKey(code));
    if (!record || record.clientId !== clientId) {
      throw invalidGrant('Invalid or expired authorization code');
    }
    // RFC 6749 4.1.3: 認可要求に含めた redirect_uri と同じものを要求する
    if (params.get('redirect_uri') !== record.redirectUri) {
      throw invalidGrant('redirect_uri does not match the authorization request');
    }
    const verifier = params.get('code_verifier') ?? '';
    if (!PKCE_VERIFIER.test(verifier) || !safeEqual(sha256(verifier), record.codeChallenge)) {
      throw invalidGrant('Invalid code_verifier');
    }

    const grantId = randomToken(16);
    const issuedAt = now();
    const grant: GrantRecord = {
      clientId,
      subject: record.subject,
      upstreamRefreshToken: encrypt(
        keys.encryptionKey,
        decrypt(keys.encryptionKey, record.upstreamRefreshToken, codeKey(code)),
        grantKey(grantId),
      ),
      generation: 0,
      rotatedAt: issuedAt,
      expiresAt: issuedAt + options.sessionTtlSeconds * 1000,
    };
    await store.put(grantKey(grantId), grant, options.sessionTtlSeconds);
    // クライアントは grant より長く残す
    await store.put(clientKey(clientId), client, options.sessionTtlSeconds);
    return issueTokens(grantId, grant, refreshTokenFor(grantId, grant.generation));
  };

  const exchangeRefreshToken = async (clientId: string, params: URLSearchParams) => {
    const presented = parseRefreshToken(params.get('refresh_token') ?? '');
    const key = grantKey(presented?.grantId ?? '');
    const grant = presented ? await store.get<GrantRecord>(key) : null;
    // RFC 6749 6: リフレッシュトークンは発行先のクライアントにしか使わせない
    if (!presented || !grant || grant.clientId !== clientId) {
      throw invalidGrant('Invalid refresh token');
    }
    const reissue = (current: GrantRecord) =>
      issueTokens(
        presented.grantId,
        current,
        refreshTokenFor(presented.grantId, current.generation),
      );
    const isRetry = (current: GrantRecord) =>
      presented.generation === current.generation - 1 &&
      now() - current.rotatedAt <= REFRESH_RETRY_GRACE_SECONDS * 1000;

    // 応答を受け取れなかったクライアントの再送。状態は変えず、同じ後継トークンを返す
    if (isRetry(grant)) {
      return reissue(grant);
    }
    // 発行済みの古いトークンが猶予を過ぎて使われた。盗まれて先に使われた可能性があるため、grant ごと失効させて
    // 盗んだ側が持つ現在のトークンも止める (MAC が合うものだけがここに来るため、無効なトークンでは失効させられない)
    if (presented.generation !== grant.generation) {
      await store.delete(key);
      log({ type: 'oauth.refresh_reuse', clientId });
      throw invalidGrant('Refresh token was already used');
    }

    // Cognito でサインアウトした・ユーザーを無効にしたなどで更新できなければ、grant ごと消して
    // 発行済みのアクセストークンも通さなくする
    let upstream: Awaited<ReturnType<typeof cognito.refresh>>;
    try {
      upstream = await cognito.refresh(
        decrypt(keys.encryptionKey, grant.upstreamRefreshToken, key),
      );
    } catch (error) {
      if (error instanceof CognitoTokenError && error.rejected) {
        await store.delete(key);
        throw invalidGrant('The login session is no longer valid');
      }
      log({ type: 'oauth.error', step: 'refresh', message: String(error) });
      throw new OAuthEndpointError('temporarily_unavailable', 'Login service unavailable', 503);
    }
    if (upstream.subject !== grant.subject) {
      await store.delete(key);
      throw invalidGrant('The login session is no longer valid');
    }

    const ttl = remainingSeconds(grant.expiresAt);
    if (ttl <= 0) {
      throw invalidGrant('The login session has expired');
    }
    const next: GrantRecord = {
      ...grant,
      upstreamRefreshToken:
        upstream.refreshToken === undefined
          ? grant.upstreamRefreshToken
          : encrypt(keys.encryptionKey, upstream.refreshToken, key),
      generation: grant.generation + 1,
      rotatedAt: now(),
    };
    if (await store.replace(key, grant, next, ttl)) {
      return reissue(next);
    }
    // 同じトークンで同時に更新され、先に別のリクエストが世代を進めた。読み直して再送として扱う
    const latest = await store.get<GrantRecord>(key);
    if (latest && latest.clientId === clientId && isRetry(latest)) {
      return reissue(latest);
    }
    throw invalidGrant('Refresh token was already used');
  };

  // 発行したアクセストークンを検証し、grant が残っていれば通す。grant を消せば (= DynamoDB の項目を消せば)
  // 期限前でも失効できる
  const authenticate = requireBearerAuth({
    resourceMetadataUrl,
    expectedResource: resourceUrl,
    requiredScopes: [SCOPE],
    verifier: {
      async verifyAccessToken(token: string): Promise<AuthInfo> {
        const claims = verifyAccessTokenJwt(keys.accessTokenKey, token, {
          issuer: baseUrl,
          audience: resourceUrl.href,
          now: now(),
        });
        const grant = claims && (await store.get<GrantRecord>(grantKey(claims.gid)));
        if (
          !claims ||
          !grant ||
          grant.clientId !== claims.client_id ||
          grant.subject !== claims.sub
        ) {
          throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid or expired access token');
        }
        return {
          token,
          clientId: claims.client_id,
          scopes: claims.scope.split(' '),
          expiresAt: claims.exp,
          resource: new URL(claims.aud),
        };
      },
    },
  });

  const routes = new Hono();

  routes.onError((error) => {
    if (error instanceof OAuthEndpointError) {
      return error.toResponse();
    }
    log({ type: 'oauth.error', message: String(error) });
    return Response.json({ error: 'server_error' }, { status: 500 });
  });

  // 同意画面を iframe に埋め込ませず (クリックジャッキングで同意させられるのを防ぐ)、スクリプトも読ませない
  routes.use('/oauth/*', async (c, next) => {
    await next();
    c.res.headers.set('X-Frame-Options', 'DENY');
    c.res.headers.set(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    );
  });
  routes.use(
    '/oauth/*',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: () =>
        new OAuthEndpointError('invalid_request', 'Request body is too large', 413).toResponse(),
    }),
  );

  routes.get('/.well-known/oauth-authorization-server', (c) => c.json(authorizationServerMetadata));
  for (const path of [
    '/.well-known/oauth-protected-resource',
    `/.well-known/oauth-protected-resource${options.resourcePath}`,
  ]) {
    routes.get(path, (c) => c.json(protectedResourceMetadata));
  }

  // RFC 7591 Dynamic Client Registration
  routes.post('/oauth/register', async (c) => {
    const parsed = registrationSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new OAuthEndpointError(
        'invalid_client_metadata',
        `${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}`,
      );
    }
    const request = parsed.data;
    const rejected = request.redirect_uris.find(
      (uri) => !isAllowedRedirectUri(uri, options.redirectUriPolicy),
    );
    if (rejected !== undefined) {
      throw new OAuthEndpointError(
        'invalid_redirect_uri',
        `Redirect URI is not allowed: ${rejected}`,
      );
    }

    const clientId = randomToken(16);
    const clientSecret = request.token_endpoint_auth_method === 'none' ? undefined : randomToken();
    const client: ClientRecord = {
      redirectUris: request.redirect_uris,
      tokenEndpointAuthMethod: request.token_endpoint_auth_method,
      clientSecretHash: clientSecret === undefined ? undefined : sha256(clientSecret),
      clientName: request.client_name,
    };
    await store.put(clientKey(clientId), client, UNUSED_CLIENT_TTL_SECONDS);
    return c.json(
      {
        client_id: clientId,
        client_id_issued_at: Math.floor(now() / 1000),
        ...(clientSecret !== undefined && {
          client_secret: clientSecret,
          client_secret_expires_at: 0,
        }),
        redirect_uris: request.redirect_uris,
        token_endpoint_auth_method: request.token_endpoint_auth_method,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        ...(request.client_name !== undefined && { client_name: request.client_name }),
      },
      201,
    );
  });

  routes.get('/oauth/authorize', async (c) => {
    const query = c.req.query();
    const { client_id: clientId, redirect_uri: redirectUri, state } = query;
    const client = clientId ? await store.get<ClientRecord>(clientKey(clientId)) : null;
    // クライアントや戻り先が確かめられないときは、戻り先へリダイレクトせずにエラー画面を出す (RFC 6749 4.1.2.1)
    if (!clientId || !client) {
      return c.html(
        errorPage('This client is not registered. Reconnect from your MCP client.'),
        400,
      );
    }
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
      return c.html(errorPage('The redirect URI does not match the client registration.'), 400);
    }
    const fail = (error: string, description: string) =>
      c.redirect(clientRedirect(redirectUri, { error, error_description: description, state }));
    if (query.response_type !== 'code') {
      return fail('unsupported_response_type', 'response_type must be code');
    }
    if (!isOwnResource(c.req.queries('resource') ?? [])) {
      return fail('invalid_target', `resource must be ${resourceUrl.href}`);
    }
    if (
      query.code_challenge_method !== 'S256' ||
      !BASE64URL_256BIT.test(query.code_challenge ?? '')
    ) {
      return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required');
    }

    const transactionId = randomToken();
    const transaction: TransactionRecord = {
      clientId,
      redirectUri,
      codeChallenge: query.code_challenge ?? '',
      state,
      browserHash: bindBrowser(c),
      upstreamVerifier: randomToken(),
      consented: false,
      expiresAt: now() + TRANSACTION_TTL_SECONDS * 1000,
    };
    await store.put(transactionKey(transactionId), transaction, TRANSACTION_TTL_SECONDS);
    return c.html(consentPage({ clientName: client.clientName, redirectUri, transactionId }));
  });

  routes.post('/oauth/consent', async (c) => {
    const form = await c.req.parseBody();
    const transactionId = typeof form.transaction_id === 'string' ? form.transaction_id : '';
    const key = transactionKey(transactionId);
    const transaction = transactionId ? await store.get<TransactionRecord>(key) : null;
    if (!transaction) {
      return c.html(
        errorPage(
          'The authorization request was not found or has expired. Reconnect from your MCP client.',
        ),
        400,
      );
    }
    if (!isSameBrowser(c, transaction)) {
      return c.html(errorPage('Continue in the browser where you opened this page.'), 403);
    }
    if (form.action === 'deny') {
      await store.delete(key);
      return c.redirect(
        clientRedirect(transaction.redirectUri, {
          error: 'access_denied',
          state: transaction.state,
        }),
        303,
      );
    }
    if (form.action !== 'approve') {
      return c.html(errorPage('Unknown action.'), 400);
    }
    await store.put(
      key,
      { ...transaction, consented: true },
      Math.max(remainingSeconds(transaction.expiresAt), 1),
    );
    return c.redirect(
      cognito.authorizeUrl({
        state: transactionId,
        codeChallenge: sha256(transaction.upstreamVerifier),
      }),
      303,
    );
  });

  routes.get('/oauth/callback', async (c) => {
    const { state, code, error } = c.req.query();
    const transaction = state ? await store.take<TransactionRecord>(transactionKey(state)) : null;
    if (!transaction?.consented) {
      return c.html(
        errorPage(
          'The authorization request was not found or has expired. Reconnect from your MCP client.',
        ),
        400,
      );
    }
    if (!isSameBrowser(c, transaction)) {
      return c.html(errorPage('Continue in the browser where you started signing in.'), 403);
    }
    const back = (params: Record<string, string>) =>
      c.redirect(clientRedirect(transaction.redirectUri, { ...params, state: transaction.state }));
    if (error !== undefined || !code) {
      return back({
        error: error === 'access_denied' ? 'access_denied' : 'server_error',
        error_description: 'Login was not completed',
      });
    }

    let upstream: Awaited<ReturnType<typeof cognito.exchangeCode>>;
    try {
      upstream = await cognito.exchangeCode({ code, codeVerifier: transaction.upstreamVerifier });
    } catch (exchangeError) {
      log({ type: 'oauth.error', step: 'callback', message: String(exchangeError) });
      return back({ error: 'server_error', error_description: 'Login failed' });
    }
    const clientCode = randomToken();
    const record: CodeRecord = {
      clientId: transaction.clientId,
      redirectUri: transaction.redirectUri,
      codeChallenge: transaction.codeChallenge,
      subject: upstream.subject,
      upstreamRefreshToken: encrypt(keys.encryptionKey, upstream.refreshToken, codeKey(clientCode)),
    };
    await store.put(codeKey(clientCode), record, AUTHORIZATION_CODE_TTL_SECONDS);
    return back({ code: clientCode });
  });

  routes.post('/oauth/token', async (c) => {
    const params = new URLSearchParams(await c.req.text());
    const { clientId, client } = await authenticateClient(c.req.header('authorization'), params);
    if (!isOwnResource(params.getAll('resource'))) {
      throw new OAuthEndpointError('invalid_target', `resource must be ${resourceUrl.href}`);
    }
    switch (params.get('grant_type')) {
      case 'authorization_code':
        return c.json(await exchangeAuthorizationCode(clientId, client, params));
      case 'refresh_token':
        return c.json(await exchangeRefreshToken(clientId, params));
      default:
        throw new OAuthEndpointError(
          'unsupported_grant_type',
          'grant_type must be authorization_code or refresh_token',
        );
    }
  });

  return { routes, authenticate };
};

export type OAuth = ReturnType<typeof createOAuth>;
