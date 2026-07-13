import { getDb } from '../db/client.js';

// Cognito の username (access token の username claim) と users.name (UNIQUE) を
// 突き合わせて user_id を解決する。管理ユーザーは admin-create-user で
// users.name と同じ username で作成する運用。user_id は不変のためプロセス内でメモ化する
const cache = new Map<string, string>();

export const resolveUserIdByName = async (name: string): Promise<string | null> => {
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  const row = await getDb()
    .selectFrom('users')
    .select('user_id')
    .where('name', '=', name)
    .executeTakeFirst();
  if (row === undefined) return null;
  cache.set(name, row.user_id);
  return row.user_id;
};
