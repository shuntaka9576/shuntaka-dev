import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { isDevAuthBypass } from '../env.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const parseOriginAllowlist = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

// SameSite=Lax の保険。変更系リクエストは Origin が allowlist 内であること
// (ブラウザ以外は Origin を送らないので不在は許容) と X-Requested-With 必須
export const isAllowedRequest = (input: {
  method: string;
  origin: string | undefined;
  requestedWith: string | undefined;
  allowlist: string[];
}): boolean => {
  if (SAFE_METHODS.has(input.method)) return true;
  if (input.origin !== undefined && !input.allowlist.includes(input.origin)) {
    return false;
  }
  return input.requestedWith !== undefined;
};

export const csrfGuard = createMiddleware(async (c, next) => {
  if (isDevAuthBypass()) {
    await next();
    return;
  }
  const ok = isAllowedRequest({
    method: c.req.method,
    origin: c.req.header('origin'),
    requestedWith: c.req.header('x-requested-with'),
    allowlist: parseOriginAllowlist(process.env.ORIGIN_ALLOWLIST),
  });
  if (!ok) throw new HTTPException(403, { message: 'forbidden' });
  await next();
});
