import { createRoute } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { ulid } from 'ulid';
import { getDb } from '../db/client.js';
import type { MealType } from '../db/types.js';
import { createRouter } from '../lib/router.js';
import {
  createQuickItemBodySchema,
  createShoppingItemBodySchema,
  generateTodoResponseSchema,
  mealParamsSchema,
  morningAchievementDateParamSchema,
  quickItemIdParamSchema,
  quickItemSchema,
  shoppingItemIdParamSchema,
  shoppingItemSchema,
  todoCalendarQuerySchema,
  todoCalendarSchema,
  todoDashboardQuerySchema,
  todoDashboardSchema,
  todoItemIdParamSchema,
  updateMealBodySchema,
  updateMorningAchievementBodySchema,
  updateQuickItemBodySchema,
  updateTodoItemBodySchema,
  updateTodoSettingsBodySchema,
} from '../schemas/todo.js';
import { generateDailyTodosForUser } from '../todo/batch.js';
import { validateTemplateItems } from '../todo/templates.js';
import { addDays, isValidTimeZone, localDateTime } from '../todo/time.js';
import { collectDescendantIds } from '../todo/tree.js';

const dashboardRoute = createRoute({
  method: 'get',
  path: '/todo',
  request: { query: todoDashboardQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: todoDashboardSchema } },
      description: '当日のチェックリスト、直近3日分の献立、買い物リスト',
    },
  },
});

const calendarRoute = createRoute({
  method: 'get',
  path: '/todo/calendar',
  request: { query: todoCalendarQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: todoCalendarSchema } },
      description: '月ごとのチェックリスト生成・完了件数',
    },
  },
});

const createQuickItemRoute = createRoute({
  method: 'post',
  path: '/todo/quick-items',
  request: { body: { content: { 'application/json': { schema: createQuickItemBodySchema } } } },
  responses: {
    201: {
      content: { 'application/json': { schema: quickItemSchema } },
      description: '日をまたいで持ち越す簡易TODOを追加',
    },
  },
});

const updateQuickItemRoute = createRoute({
  method: 'patch',
  path: '/todo/quick-items/{id}',
  request: {
    params: quickItemIdParamSchema,
    body: { content: { 'application/json': { schema: updateQuickItemBodySchema } } },
  },
  responses: { 204: { description: '簡易TODOのチェック状態を更新' } },
});

const deleteQuickItemRoute = createRoute({
  method: 'delete',
  path: '/todo/quick-items/{id}',
  request: { params: quickItemIdParamSchema },
  responses: { 204: { description: '簡易TODOを削除' } },
});

const updateSettingsRoute = createRoute({
  method: 'put',
  path: '/todo/settings',
  request: { body: { content: { 'application/json': { schema: updateTodoSettingsBodySchema } } } },
  responses: { 204: { description: '設定とテンプレートを保存' } },
});

const updateMorningAchievementRoute = createRoute({
  method: 'put',
  path: '/todo/morning-achievements/{date}',
  request: {
    params: morningAchievementDateParamSchema,
    body: { content: { 'application/json': { schema: updateMorningAchievementBodySchema } } },
  },
  responses: { 204: { description: '日付ごとの朝活実績を保存。空文字なら削除' } },
});

const generateRoute = createRoute({
  method: 'post',
  path: '/todo/generate',
  responses: {
    200: {
      content: { 'application/json': { schema: generateTodoResponseSchema } },
      description: '当日分を手動生成（バッチ失敗時のフォールバック）',
    },
  },
});

const updateItemRoute = createRoute({
  method: 'patch',
  path: '/todo/items/{id}',
  request: {
    params: todoItemIdParamSchema,
    body: { content: { 'application/json': { schema: updateTodoItemBodySchema } } },
  },
  responses: { 204: { description: 'チェック状態を更新' } },
});

const updateMealRoute = createRoute({
  method: 'put',
  path: '/todo/meals/{date}/{type}',
  request: {
    params: mealParamsSchema,
    body: { content: { 'application/json': { schema: updateMealBodySchema } } },
  },
  responses: { 204: { description: '献立を保存。空文字なら未定へ戻す' } },
});

const createShoppingRoute = createRoute({
  method: 'post',
  path: '/todo/shopping',
  request: {
    body: { content: { 'application/json': { schema: createShoppingItemBodySchema } } },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: shoppingItemSchema } },
      description: '買い物項目を追加。同名は数量を含めて更新',
    },
  },
});

const deleteShoppingRoute = createRoute({
  method: 'delete',
  path: '/todo/shopping/{id}',
  request: { params: shoppingItemIdParamSchema },
  responses: { 204: { description: '購入済み・不要な項目を除外' } },
});

const normalizeShoppingName = (name: string): string =>
  name.normalize('NFKC').toLocaleLowerCase('ja-JP').replace(/\s+/g, ' ').trim();

const nextMonth = (month: string): string => {
  const [year = 0, monthNumber = 1] = month.split('-').map(Number);
  return monthNumber === 12
    ? `${year + 1}-01`
    : `${year}-${String(monthNumber + 1).padStart(2, '0')}`;
};

export const todoRoutes = createRouter()
  .openapi(dashboardRoute, async (c) => {
    const userId = c.get('userId');
    const db = getDb();
    const setting = await db
      .selectFrom('todo_settings')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirst();
    const timezone = setting?.timezone ?? 'Asia/Tokyo';
    const today = localDateTime(new Date(), timezone).date;
    const date = c.req.valid('query').date ?? today;
    const lastDate = addDays(date, 2);

    const [templates, checklistRows, achievement, quickTodoRows, mealRows, shoppingRows] =
      await Promise.all([
        setting === undefined
          ? Promise.resolve([])
          : db
              .selectFrom('todo_template_items')
              .selectAll()
              .where('user_id', '=', userId)
              .orderBy('period')
              .orderBy('position')
              .execute(),
        db
          .selectFrom('todo_daily_items')
          .selectAll()
          .where('user_id', '=', userId)
          .where('todo_date', '=', date)
          .orderBy('period')
          .orderBy('position')
          .execute(),
        db
          .selectFrom('todo_morning_achievements')
          .selectAll()
          .where('user_id', '=', userId)
          .where('achievement_date', '=', date)
          .executeTakeFirst(),
        db
          .selectFrom('todo_quick_items')
          .selectAll()
          .where('user_id', '=', userId)
          .orderBy('category')
          .orderBy('created_at')
          .execute(),
        db
          .selectFrom('todo_meals')
          .selectAll()
          .where('user_id', '=', userId)
          .where('meal_date', '>=', date)
          .where('meal_date', '<=', lastDate)
          .orderBy('meal_date')
          .execute(),
        db
          .selectFrom('todo_shopping_items')
          .selectAll()
          .where('user_id', '=', userId)
          .orderBy('created_at')
          .execute(),
      ]);

    const mealByDate = new Map<string, Partial<Record<MealType, string>>>();
    for (const row of mealRows) {
      const meals = mealByDate.get(row.meal_date) ?? {};
      meals[row.meal_type] = row.content;
      mealByDate.set(row.meal_date, meals);
    }

    return c.json(
      {
        date,
        today,
        settings:
          setting === undefined
            ? null
            : {
                timezone: setting.timezone,
                generationTime: setting.generation_time,
                sourceMarkdown: setting.source_markdown,
                items: templates.map((row) => ({
                  key: row.template_item_id,
                  parentKey: row.parent_template_item_id,
                  period: row.period,
                  title: row.title,
                  position: row.position,
                })),
              },
        checklist: checklistRows.map((row) => ({
          itemId: row.daily_item_id,
          parentItemId: row.parent_daily_item_id,
          period: row.period,
          title: row.title,
          position: row.position,
          completedAt: row.completed_at?.toISOString() ?? null,
        })),
        morningAchievement:
          achievement === undefined
            ? null
            : {
                parentingLoad: achievement.parenting_load,
                freeMinutes: achievement.free_minutes as 0 | 30 | 60 | 90 | 120,
                allocation: achievement.allocation,
                note: achievement.note ?? '',
              },
        quickTodos: quickTodoRows.map((row) => ({
          itemId: row.quick_item_id,
          category: row.category,
          title: row.title,
          completedAt: row.completed_at?.toISOString() ?? null,
        })),
        meals: [0, 1, 2].map((offset) => {
          const mealDate = addDays(date, offset);
          const meals = mealByDate.get(mealDate);
          return {
            date: mealDate,
            breakfast: meals?.breakfast ?? null,
            lunch: meals?.lunch ?? null,
            dinner: meals?.dinner ?? null,
          };
        }),
        shopping: shoppingRows.map((row) => ({
          itemId: row.shopping_item_id,
          name: row.name,
          quantity: row.quantity,
        })),
      },
      200,
    );
  })
  .openapi(calendarRoute, async (c) => {
    const userId = c.get('userId');
    const setting = await getDb()
      .selectFrom('todo_settings')
      .select('timezone')
      .where('user_id', '=', userId)
      .executeTakeFirst();
    const today = localDateTime(new Date(), setting?.timezone ?? 'Asia/Tokyo').date;
    const month = c.req.valid('query').month ?? today.slice(0, 7);
    const firstDate = `${month}-01`;
    const lastDate = addDays(`${nextMonth(month)}-01`, -1);
    const [rows, achievements] = await Promise.all([
      getDb()
        .selectFrom('todo_daily_items')
        .select(['todo_date', 'completed_at'])
        .where('user_id', '=', userId)
        .where('todo_date', '>=', firstDate)
        .where('todo_date', '<=', lastDate)
        .orderBy('todo_date')
        .execute(),
      getDb()
        .selectFrom('todo_morning_achievements')
        .select('achievement_date')
        .where('user_id', '=', userId)
        .where('achievement_date', '>=', firstDate)
        .where('achievement_date', '<=', lastDate)
        .execute(),
    ]);
    const counts = new Map<string, { total: number; completed: number }>();
    for (const row of rows) {
      const count = counts.get(row.todo_date) ?? { total: 0, completed: 0 };
      count.total += 1;
      if (row.completed_at !== null) count.completed += 1;
      counts.set(row.todo_date, count);
    }
    const achievementDates = new Set(achievements.map((row) => row.achievement_date));
    const dates = new Set([...counts.keys(), ...achievementDates]);
    return c.json(
      {
        month,
        today,
        days: [...dates].sort().map((date) => ({
          date,
          ...(counts.get(date) ?? { total: 0, completed: 0 }),
          hasMorningAchievement: achievementDates.has(date),
        })),
      },
      200,
    );
  })
  .openapi(updateMorningAchievementRoute, async (c) => {
    const { date } = c.req.valid('param');
    const body = c.req.valid('json');
    const userId = c.get('userId');
    await getDb()
      .insertInto('todo_morning_achievements')
      .values({
        achievement_id: ulid(),
        user_id: userId,
        achievement_date: date,
        parenting_load: body.parentingLoad,
        free_minutes: body.freeMinutes,
        allocation: body.allocation,
        note: body.note.trim() === '' ? null : body.note.trim(),
      })
      .onDuplicateKeyUpdate({
        parenting_load: body.parentingLoad,
        free_minutes: body.freeMinutes,
        allocation: body.allocation,
        note: body.note.trim() === '' ? null : body.note.trim(),
      })
      .execute();
    return c.body(null, 204);
  })
  .openapi(createQuickItemRoute, async (c) => {
    const body = c.req.valid('json');
    const quickItemId = ulid();
    const userId = c.get('userId');
    await getDb()
      .insertInto('todo_quick_items')
      .values({
        quick_item_id: quickItemId,
        user_id: userId,
        category: body.category,
        title: body.title,
        completed_at: null,
      })
      .execute();
    return c.json(
      { itemId: quickItemId, category: body.category, title: body.title, completedAt: null },
      201,
    );
  })
  .openapi(updateQuickItemRoute, async (c) => {
    const { id } = c.req.valid('param');
    const { completed } = c.req.valid('json');
    const result = await getDb()
      .updateTable('todo_quick_items')
      .set({ completed_at: completed ? new Date() : null })
      .where('quick_item_id', '=', id)
      .where('user_id', '=', c.get('userId'))
      .executeTakeFirst();
    if (result.numUpdatedRows === 0n) {
      throw new HTTPException(404, { message: 'quick todo item not found' });
    }
    return c.body(null, 204);
  })
  .openapi(deleteQuickItemRoute, async (c) => {
    const { id } = c.req.valid('param');
    const result = await getDb()
      .deleteFrom('todo_quick_items')
      .where('quick_item_id', '=', id)
      .where('user_id', '=', c.get('userId'))
      .executeTakeFirst();
    if (result.numDeletedRows === 0n) {
      throw new HTTPException(404, { message: 'quick todo item not found' });
    }
    return c.body(null, 204);
  })
  .openapi(updateSettingsRoute, async (c) => {
    const userId = c.get('userId');
    const body = c.req.valid('json');
    if (!isValidTimeZone(body.timezone)) {
      throw new HTTPException(400, { message: 'invalid timezone' });
    }
    validateTemplateItems(body.items);

    const db = getDb();
    const previousTemplate = await db
      .selectFrom('todo_template_items')
      .select('template_item_id')
      .where('user_id', '=', userId)
      .executeTakeFirst();
    const idByKey = new Map(body.items.map((item) => [item.key, ulid()]));

    await db.transaction().execute(async (trx) => {
      await trx.deleteFrom('todo_template_items').where('user_id', '=', userId).execute();
      if (body.items.length > 0) {
        await trx
          .insertInto('todo_template_items')
          .values(
            body.items.map((item) => ({
              template_item_id: idByKey.get(item.key)!,
              user_id: userId,
              period: item.period,
              parent_template_item_id:
                item.parentKey === null ? null : (idByKey.get(item.parentKey) ?? null),
              title: item.title,
              position: item.position,
            })),
          )
          .execute();
      }
      await trx
        .insertInto('todo_settings')
        .values({
          user_id: userId,
          timezone: body.timezone,
          generation_time: body.generationTime,
          source_markdown: body.sourceMarkdown,
        })
        .onDuplicateKeyUpdate({
          timezone: body.timezone,
          generation_time: body.generationTime,
          source_markdown: body.sourceMarkdown,
        })
        .execute();
    });

    // 初回登録だけはその場で当日分を作る。以後の編集は翌朝のスナップショットから反映する。
    if (previousTemplate === undefined && body.items.length > 0) {
      const date = localDateTime(new Date(), body.timezone).date;
      await generateDailyTodosForUser(userId, date);
    }
    return c.body(null, 204);
  })
  .openapi(generateRoute, async (c) => {
    const userId = c.get('userId');
    const setting = await getDb()
      .selectFrom('todo_settings')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (setting === undefined) throw new HTTPException(409, { message: 'todo is not configured' });
    const date = localDateTime(new Date(), setting.timezone).date;
    const created = await generateDailyTodosForUser(userId, date);
    return c.json({ date, created }, 200);
  })
  .openapi(updateItemRoute, async (c) => {
    const { id } = c.req.valid('param');
    const { completed } = c.req.valid('json');
    const userId = c.get('userId');
    const db = getDb();
    const target = await db
      .selectFrom('todo_daily_items')
      .select(['daily_item_id', 'todo_date'])
      .where('daily_item_id', '=', id)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (target === undefined) {
      throw new HTTPException(404, { message: 'todo item not found' });
    }
    const items = await db
      .selectFrom('todo_daily_items')
      .select(['daily_item_id', 'parent_daily_item_id'])
      .where('user_id', '=', userId)
      .where('todo_date', '=', target.todo_date)
      .execute();
    const itemIds = collectDescendantIds(
      items.map((item) => ({ id: item.daily_item_id, parentId: item.parent_daily_item_id })),
      id,
    );
    await db
      .updateTable('todo_daily_items')
      .set({ completed_at: completed ? new Date() : null })
      .where('daily_item_id', 'in', itemIds)
      .where('user_id', '=', userId)
      .execute();
    return c.body(null, 204);
  })
  .openapi(updateMealRoute, async (c) => {
    const { date, type } = c.req.valid('param');
    const { content } = c.req.valid('json');
    const userId = c.get('userId');
    const db = getDb();
    if (content === '') {
      await db
        .deleteFrom('todo_meals')
        .where('user_id', '=', userId)
        .where('meal_date', '=', date)
        .where('meal_type', '=', type)
        .execute();
    } else {
      await db
        .insertInto('todo_meals')
        .values({ meal_id: ulid(), user_id: userId, meal_date: date, meal_type: type, content })
        .onDuplicateKeyUpdate({ content })
        .execute();
    }
    return c.body(null, 204);
  })
  .openapi(createShoppingRoute, async (c) => {
    const body = c.req.valid('json');
    const userId = c.get('userId');
    const normalizedName = normalizeShoppingName(body.name);
    const quantity = body.quantity === undefined || body.quantity === '' ? null : body.quantity;
    const db = getDb();
    await db
      .insertInto('todo_shopping_items')
      .values({
        shopping_item_id: ulid(),
        user_id: userId,
        name: body.name,
        normalized_name: normalizedName,
        quantity,
      })
      .onDuplicateKeyUpdate({ name: body.name, quantity })
      .execute();
    const row = await db
      .selectFrom('todo_shopping_items')
      .selectAll()
      .where('user_id', '=', userId)
      .where('normalized_name', '=', normalizedName)
      .executeTakeFirstOrThrow();
    return c.json({ itemId: row.shopping_item_id, name: row.name, quantity: row.quantity }, 201);
  })
  .openapi(deleteShoppingRoute, async (c) => {
    const { id } = c.req.valid('param');
    const result = await getDb()
      .deleteFrom('todo_shopping_items')
      .where('shopping_item_id', '=', id)
      .where('user_id', '=', c.get('userId'))
      .executeTakeFirst();
    if (result.numDeletedRows === 0n) {
      throw new HTTPException(404, { message: 'shopping item not found' });
    }
    return c.body(null, 204);
  });
