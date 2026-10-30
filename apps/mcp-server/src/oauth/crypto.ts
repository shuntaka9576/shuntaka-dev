import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/** 推測できない値 (クライアント ID、認可コード、リフレッシュトークンなど)。既定は 256 bit */
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

/** 認可コード・リフレッシュトークン・クライアントシークレットは平文で保存せず、ハッシュで照合する。PKCE の S256 も同じ計算 */
export const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('base64url');

export const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

// Cognito のリフレッシュトークンを保存するときの暗号化 (AES-256-GCM)。context を追加認証データに入れ、
// 暗号文を別の項目 (別の grant など) へ移しても復号できないようにする
export const encrypt = (key: Buffer, plaintext: string, context: string): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv).setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv, body, cipher.getAuthTag()].map((part) => part.toString('base64url')).join('.');
};

export const decrypt = (key: Buffer, value: string, context: string): string => {
  const [iv, body, tag] = value.split('.').map((part) => Buffer.from(part, 'base64url'));
  if (!iv || !body || !tag) {
    throw new Error('Malformed encrypted value');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
    .setAAD(Buffer.from(context))
    .setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
};

export interface AccessTokenClaims {
  iss: string;
  aud: string;
  /** Cognito のユーザー (sub) */
  sub: string;
  client_id: string;
  scope: string;
  /** grant の ID。grant が消えていればトークンも通さない */
  gid: string;
  iat: number;
  exp: number;
  jti: string;
}

// アクセストークンは HS256 の JWT。typ を at+jwt (RFC 9068) にし、検証時にも確かめる。
// リフレッシュトークンは JWT ではない不透明な値なので、2 つを取り違えて使うことはできない
const ACCESS_TOKEN_HEADER = { alg: 'HS256', typ: 'at+jwt' };

const encodeJson = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

const decodeJson = (value: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

/** アクセストークンの署名とリフレッシュトークンの MAC */
export const hmacSha256 = (key: Buffer, input: string): string =>
  createHmac('sha256', key).update(input).digest('base64url');

export const signAccessToken = (key: Buffer, claims: AccessTokenClaims): string => {
  const input = `${encodeJson(ACCESS_TOKEN_HEADER)}.${encodeJson(claims)}`;
  return `${input}.${hmacSha256(key, input)}`;
};

/** 署名・種別・発行者・宛先・期限を確かめ、通ればクレームを返す */
export const verifyAccessToken = (
  key: Buffer,
  token: string,
  expected: { issuer: string; audience: string; now: number },
): AccessTokenClaims | null => {
  const [header, payload, signature, ...rest] = token.split('.');
  if (!header || !payload || !signature || rest.length > 0) {
    return null;
  }
  if (!safeEqual(signature, hmacSha256(key, `${header}.${payload}`))) {
    return null;
  }
  const decodedHeader = decodeJson(header);
  if (
    decodedHeader?.alg !== ACCESS_TOKEN_HEADER.alg ||
    decodedHeader.typ !== ACCESS_TOKEN_HEADER.typ
  ) {
    return null;
  }
  const claims = decodeJson(payload);
  if (
    claims === null ||
    claims.iss !== expected.issuer ||
    claims.aud !== expected.audience ||
    typeof claims.exp !== 'number' ||
    claims.exp * 1000 <= expected.now ||
    typeof claims.sub !== 'string' ||
    typeof claims.client_id !== 'string' ||
    typeof claims.scope !== 'string' ||
    typeof claims.gid !== 'string'
  ) {
    return null;
  }
  return claims as unknown as AccessTokenClaims;
};
