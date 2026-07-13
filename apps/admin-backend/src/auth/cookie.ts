import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import * as Iron from 'iron-webcrypto';
import { isInsecureCookies } from '../env.js';
import { getCookieSecret } from './secret.js';

// refresh token の TTL (30 日) に揃える
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const sessionCookieName = (): string => (isInsecureCookies() ? 'session' : '__Host-session');

export const setSessionCookie = async (c: Context, sid: string): Promise<void> => {
  const sealed = await Iron.seal({ sid }, await getCookieSecret(), {
    ...Iron.defaults,
    ttl: SESSION_TTL_MS,
  });
  setCookie(c, sessionCookieName(), sealed, {
    httpOnly: true,
    secure: !isInsecureCookies(),
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  });
};

// Cookie を unseal して sid を返す。Cookie 無し・改ざん・期限切れは null
export const readSessionSid = async (c: Context): Promise<string | null> => {
  const sealed = getCookie(c, sessionCookieName());
  if (sealed === undefined) return null;
  try {
    const unsealed: unknown = await Iron.unseal(sealed, await getCookieSecret(), Iron.defaults);
    if (
      typeof unsealed === 'object' &&
      unsealed !== null &&
      'sid' in unsealed &&
      typeof unsealed.sid === 'string'
    ) {
      return unsealed.sid;
    }
    return null;
  } catch {
    return null;
  }
};

export const clearSessionCookie = (c: Context): void => {
  deleteCookie(c, sessionCookieName(), { path: '/' });
};
