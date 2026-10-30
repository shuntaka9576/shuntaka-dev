// ログインを任せる Cognito (admin のユーザープールの managed login) とのやり取り。
// MCP サーバーは Cognito の機密クライアントとして、認可コードフロー (PKCE 付き) でユーザーを確かめる。
// Cognito のトークンは MCP クライアントに渡さず、リフレッシュトークンだけを暗号化して grant に持つ
export interface CognitoConfig {
  /** 例: https://xxx.auth.ap-northeast-1.amazoncognito.com */
  domainUrl: string;
  /** ID トークンの iss。例: https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_xxx */
  issuer: string;
  clientId: string;
  clientSecret: string;
}

/** rejected は Cognito がコードやリフレッシュトークンを無効と答えたとき (期限切れ、サインアウト、ユーザーの無効化) */
export class CognitoTokenError extends Error {
  constructor(
    readonly rejected: boolean,
    message: string,
  ) {
    super(message);
  }
}

const TOKEN_REQUEST_TIMEOUT_MS = 10_000;

/**
 * ID トークンを確かめて sub を返す。トークンエンドポイントから TLS で直接受け取ったものなので、署名の検証は省く
 * (OIDC Core 3.1.3.7 の 6)。iss・aud・exp は確かめる
 */
const verifiedSubject = (
  idToken: unknown,
  expected: { issuer: string; clientId: string; now: number },
): string => {
  const invalid = () => new CognitoTokenError(false, 'Cognito returned an invalid id_token');
  if (typeof idToken !== 'string') {
    throw invalid();
  }
  let claims: { iss?: unknown; aud?: unknown; exp?: unknown; sub?: unknown };
  try {
    claims = JSON.parse(
      Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as typeof claims;
  } catch {
    throw invalid();
  }
  if (
    claims.iss !== expected.issuer ||
    claims.aud !== expected.clientId ||
    typeof claims.exp !== 'number' ||
    claims.exp * 1000 <= expected.now ||
    typeof claims.sub !== 'string'
  ) {
    throw invalid();
  }
  return claims.sub;
};

export const createCognitoClient = (
  config: CognitoConfig & { redirectUri: string; fetch: typeof fetch; now: () => number },
) => {
  const subjectOf = (idToken: unknown) =>
    verifiedSubject(idToken, {
      issuer: config.issuer,
      clientId: config.clientId,
      now: config.now(),
    });
  // Cognito の client_secret_basic は client_id:client_secret をそのまま Base64 にする
  const authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`;

  const requestToken = async (params: Record<string, string>) => {
    let response: Response;
    try {
      response = await config.fetch(`${config.domainUrl}/oauth2/token`, {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: config.clientId, ...params }),
        signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new CognitoTokenError(false, `Cognito token request failed: ${String(error)}`);
    }
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) {
      throw new CognitoTokenError(
        response.status === 400 && body?.error === 'invalid_grant',
        `Cognito token endpoint returned ${response.status} ${String(body?.error)}`,
      );
    }
    return body ?? {};
  };

  return {
    authorizeUrl(input: { state: string; codeChallenge: string }): string {
      const url = new URL(`${config.domainUrl}/oauth2/authorize`);
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        scope: 'openid',
        state: input.state,
        code_challenge: input.codeChallenge,
        code_challenge_method: 'S256',
      }).toString();
      return url.toString();
    },

    async exchangeCode(input: { code: string; codeVerifier: string }) {
      const body = await requestToken({
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: config.redirectUri,
        code_verifier: input.codeVerifier,
      });
      if (typeof body.refresh_token !== 'string') {
        throw new CognitoTokenError(false, 'Cognito token response lacks refresh_token');
      }
      return { subject: subjectOf(body.id_token), refreshToken: body.refresh_token };
    },

    /** ユーザーがまだ有効かを確かめる。Cognito でリフレッシュトークンのローテーションを有効にしていれば新しいものが返る */
    async refresh(refreshToken: string) {
      const body = await requestToken({ grant_type: 'refresh_token', refresh_token: refreshToken });
      return {
        subject: subjectOf(body.id_token),
        refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
      };
    },
  };
};

export type CognitoClient = ReturnType<typeof createCognitoClient>;
