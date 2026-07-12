import type { Selectable } from 'kysely';
import { getDb } from '../db/client.js';
import type { AdminSessionsTable } from '../db/types.js';

export type AdminSession = Selectable<AdminSessionsTable>;

export const createSession = async (input: {
  sid: string;
  accessToken: string;
  idToken: string;
  refreshToken: string;
  expiresAt: Date;
}): Promise<void> => {
  await getDb()
    .insertInto('admin_sessions')
    .values({
      sid: input.sid,
      access_token: input.accessToken,
      id_token: input.idToken,
      refresh_token: input.refreshToken,
      expires_at: input.expiresAt,
    })
    .execute();
};

export const findSession = async (sid: string): Promise<AdminSession | undefined> =>
  getDb().selectFrom('admin_sessions').selectAll().where('sid', '=', sid).executeTakeFirst();

export const updateSessionTokens = async (
  sid: string,
  tokens: { accessToken: string; idToken: string },
): Promise<void> => {
  await getDb()
    .updateTable('admin_sessions')
    .set({ access_token: tokens.accessToken, id_token: tokens.idToken })
    .where('sid', '=', sid)
    .execute();
};

export const deleteSession = async (sid: string): Promise<void> => {
  await getDb().deleteFrom('admin_sessions').where('sid', '=', sid).execute();
};

// 期限切れセッションの掃除。単一ユーザー運用のため cron は持たずログイン時に呼ぶ
export const deleteExpiredSessions = async (): Promise<void> => {
  await getDb().deleteFrom('admin_sessions').where('expires_at', '<', new Date()).execute();
};
