import { randomBytes } from 'node:crypto';
import { createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { revokeRefreshToken, verifyAccessToken } from '../auth/cognito.js';
import {
  SESSION_TTL_MS,
  clearSessionCookie,
  readSessionSid,
  setSessionCookie,
} from '../auth/cookie.js';
import {
  createSession,
  deleteExpiredSessions,
  deleteSession,
  findSession,
} from '../auth/session-store.js';
import { resolveUserIdByName } from '../auth/user.js';
import { createRouter } from '../lib/router.js';

const loginBodySchema = z.object({
  accessToken: z.string().min(1),
  idToken: z.string().min(1),
  refreshToken: z.string().min(1),
});

const loginRoute = createRoute({
  method: 'post',
  path: '/auth/login',
  request: {
    body: { content: { 'application/json': { schema: loginBodySchema } } },
  },
  responses: {
    204: { description: 'セッションを確立し Cookie を発行' },
  },
});

const logoutRoute = createRoute({
  method: 'post',
  path: '/auth/logout',
  responses: {
    204: { description: 'セッション削除 + RevokeToken + Cookie 破棄' },
  },
});

export const authRoutes = createRouter()
  .openapi(loginRoute, async (c) => {
    const { accessToken, idToken, refreshToken } = c.req.valid('json');
    let username: unknown;
    try {
      const payload = await verifyAccessToken(accessToken);
      username = payload.username;
    } catch {
      throw new HTTPException(401, { message: 'invalid token' });
    }
    // ログインユーザーの user_id はここで一度だけ解決し、セッションレコードに保存する。
    // users に対応レコードが無い Cognito ユーザーは拒否する
    if (typeof username !== 'string' || username === '') {
      throw new HTTPException(401, { message: 'invalid token' });
    }
    const userId = await resolveUserIdByName(username);
    if (userId === null) {
      throw new HTTPException(401, { message: 'unknown user' });
    }
    // 期限切れセッションはログイン時に掃除する
    await deleteExpiredSessions();
    const sid = randomBytes(32).toString('hex');
    await createSession({
      sid,
      userId,
      accessToken,
      idToken,
      refreshToken,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    });
    await setSessionCookie(c, sid);
    return c.body(null, 204);
  })
  .openapi(logoutRoute, async (c) => {
    const sid = await readSessionSid(c);
    if (sid !== null) {
      const session = await findSession(sid);
      if (session !== undefined) {
        await deleteSession(sid);
        try {
          await revokeRefreshToken(session.refresh_token);
        } catch {
          // revoke はベストエフォート (セッションレコードは削除済み)
        }
      }
    }
    clearSessionCookie(c);
    return c.body(null, 204);
  });
