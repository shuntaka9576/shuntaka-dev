import { createHash } from 'node:crypto';
import { getDb } from '../db/client.js';
import { localDateTime } from './time.js';

const dailyItemId = (userId: string, date: string, templateId: string): string =>
  createHash('sha256').update(`${userId}:${date}:${templateId}`).digest('hex').slice(0, 26);

export const generateDailyTodosForUser = async (userId: string, date: string): Promise<number> => {
  const templates = await getDb()
    .selectFrom('todo_template_items')
    .selectAll()
    .where('user_id', '=', userId)
    .orderBy('period')
    .orderBy('position')
    .execute();
  if (templates.length === 0) return 0;

  const rows = templates.map((template) => ({
    daily_item_id: dailyItemId(userId, date, template.template_item_id),
    user_id: userId,
    todo_date: date,
    source_template_id: template.template_item_id,
    parent_daily_item_id:
      template.parent_template_item_id === null
        ? null
        : dailyItemId(userId, date, template.parent_template_item_id),
    period: template.period,
    title: template.title,
    position: template.position,
    completed_at: null,
  }));

  const existing = await getDb()
    .selectFrom('todo_daily_items')
    .select('source_template_id')
    .where('user_id', '=', userId)
    .where('todo_date', '=', date)
    .execute();
  const existingIds = new Set(existing.map((row) => row.source_template_id));
  const missing = rows.filter((row) => !existingIds.has(row.source_template_id));
  if (missing.length === 0) return 0;

  // EventBridge は at-least-once なので、決定的 ID + INSERT IGNORE で冪等にする。
  await getDb().insertInto('todo_daily_items').ignore().values(missing).execute();
  return missing.length;
};

export const runTodoBatch = async (instant = new Date()): Promise<{ generated: number }> => {
  const settings = await getDb().selectFrom('todo_settings').selectAll().execute();
  let generated = 0;
  for (const setting of settings) {
    const local = localDateTime(instant, setting.timezone);
    if (local.time < setting.generation_time) continue;
    generated += await generateDailyTodosForUser(setting.user_id, local.date);
  }
  return { generated };
};
