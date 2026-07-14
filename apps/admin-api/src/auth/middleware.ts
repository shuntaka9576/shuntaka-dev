import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { refreshTokens, verifyAccessToken } from './cognito.js';
import { readSessionSid } from './cookie.js';
import { deleteSession, findSession, updateSessionTokens } from './session-store.js';

// access token の残り寿命がこの閾値を切ったらサーバ側で refresh する
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export type AppEnv = { Variables: { sid: string; userId: string } };

const unauthorized = (): HTTPException => new HTTPException(401, { message: 'unauthorized' });

export const sessionAuth = createMiddleware<AppEnv>(async (c, next) => {
  const sid = await readSessionSid(c);
  if (sid === null) throw unauthorized();
  const session = await findSession(sid);
  if (session === undefined || session.expires_at.getTime() < Date.now()) {
    throw unauthorized();
  }
  const ok = await verifyOrRefresh(sid, session.access_token, session.refresh_token);
  if (!ok) {
    await deleteSession(sid);
    throw unauthorized();
  }
  c.set('sid', sid);
  // ログインユーザーの user_id はログイン時に解決してセッションに保存済み
  c.set('userId', session.user_id);
  await next();
});

const verifyOrRefresh = async (
  sid: string,
  accessToken: string,
  refreshToken: string,
): Promise<boolean> => {
  try {
    const payload = await verifyAccessToken(accessToken);
    const expMs = (payload.exp ?? 0) * 1000;
    if (expMs - Date.now() > REFRESH_MARGIN_MS) return true;
  } catch {
    // 失効・不正は refresh にフォールバック
  }
  try {
    const refreshed = await refreshTokens(refreshToken);
    await verifyAccessToken(refreshed.accessToken);
    await updateSessionTokens(sid, refreshed);
    return true;
  } catch {
    return false;
  }
};
