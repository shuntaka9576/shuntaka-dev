import { createRoute } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import type { Selectable } from 'kysely';
import { ulid } from 'ulid';
import { getDb } from '../db/client.js';
import type { MomentsTable } from '../db/types.js';
import { imageUrl, thumbKey } from '../lib/images.js';
import { createRouter } from '../lib/router.js';
import { decodeCursor, encodeCursor } from '../schemas/cursor.js';
import {
  createMomentBodySchema,
  listMomentsQuerySchema,
  momentIdParamSchema,
  momentListSchema,
  momentSchema,
  updateMomentBodySchema,
} from '../schemas/moment.js';

const toMomentDto = (row: Selectable<MomentsTable>) => ({
  momentId: row.moment_id,
  text: row.text,
  imageKey: row.image_key,
  imageUrl: imageUrl(row.image_key),
  thumbUrl: imageUrl(thumbKey(row.image_key)),
  fastener: row.fastener,
  fastenerColor: row.fastener_color,
  status: row.status,
  // timezone: 'Z' で読むため UTC フィールドがそのまま壁時計。Z を付けず TZ なしで返す
  capturedAt: row.captured_at.toISOString().slice(0, 19),
  publishedAt: row.published_at?.toISOString() ?? null,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const findMoment = async (
  momentId: string,
  userId: string,
): Promise<Selectable<MomentsTable> | undefined> =>
  getDb()
    .selectFrom('moments')
    .selectAll()
    .where('moment_id', '=', momentId)
    .where('user_id', '=', userId)
    .executeTakeFirst();

const listRoute = createRoute({
  method: 'get',
  path: '/moments',
  request: { query: listMomentsQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: momentListSchema } },
      description: 'draft 含む全 status の一覧 (moment_id の降順、cursor ページング)',
    },
  },
});

const getMomentRoute = createRoute({
  method: 'get',
  path: '/moments/{id}',
  request: { params: momentIdParamSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: momentSchema } },
      description: 'moment 1 件 (編集フォームの初期値用)',
    },
  },
});

const createMomentRoute = createRoute({
  method: 'post',
  path: '/moments',
  request: {
    body: { content: { 'application/json': { schema: createMomentBodySchema } } },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: momentSchema } },
      description: '作成した moment',
    },
  },
});

const updateMomentRoute = createRoute({
  method: 'patch',
  path: '/moments/{id}',
  request: {
    params: momentIdParamSchema,
    body: { content: { 'application/json': { schema: updateMomentBodySchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: momentSchema } },
      description: '更新後の moment (draft → published の公開操作を含む)',
    },
  },
});

const deleteMomentRoute = createRoute({
  method: 'delete',
  path: '/moments/{id}',
  request: { params: momentIdParamSchema },
  responses: {
    204: { description: '削除完了' },
  },
});

export const momentRoutes = createRouter()
  .openapi(listRoute, async (c) => {
    const { cursor: cursorRaw, limit } = c.req.valid('query');
    let query = getDb()
      .selectFrom('moments')
      .selectAll()
      .where('user_id', '=', c.get('userId'))
      .orderBy('moment_id', 'desc')
      .limit(limit + 1);
    if (cursorRaw !== undefined) {
      const cursor = decodeCursor(cursorRaw);
      if (cursor === null) throw new HTTPException(400, { message: 'invalid cursor' });
      query = query.where('moment_id', '<', cursor.momentId);
    }
    const rows = await query.execute();
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(toMomentDto);
    const last = items.at(-1);
    return c.json(
      {
        items,
        nextCursor:
          hasMore && last !== undefined ? encodeCursor({ momentId: last.momentId }) : null,
      },
      200,
    );
  })
  .openapi(getMomentRoute, async (c) => {
    const { id } = c.req.valid('param');
    const row = await findMoment(id, c.get('userId'));
    if (row === undefined) throw new HTTPException(404, { message: 'moment not found' });
    return c.json(toMomentDto(row), 200);
  })
  .openapi(createMomentRoute, async (c) => {
    const body = c.req.valid('json');
    const momentId = ulid();
    await getDb()
      .insertInto('moments')
      .values({
        moment_id: momentId,
        user_id: c.get('userId'),
        text: body.text,
        image_key: body.imageKey,
        fastener: body.fastener,
        fastener_color: body.fastenerColor ?? null,
        status: body.status,
        captured_at: body.capturedAt,
        published_at: body.status === 'published' ? new Date() : null,
      })
      .execute();
    const row = await findMoment(momentId, c.get('userId'));
    if (row === undefined) throw new HTTPException(500, { message: 'failed to create moment' });
    return c.json(toMomentDto(row), 201);
  })
  .openapi(updateMomentRoute, async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const current = await findMoment(id, c.get('userId'));
    if (current === undefined) throw new HTTPException(404, { message: 'moment not found' });

    const fastener = body.fastener ?? current.fastener;
    const fastenerColor =
      body.fastenerColor === undefined ? current.fastener_color : body.fastenerColor;
    if (fastenerColor !== null && fastener !== 'tape') {
      throw new HTTPException(400, {
        message: 'fastenerColor is only valid when fastener is tape',
      });
    }

    const status = body.status ?? current.status;
    // 初回公開時刻の記録。published へ遷移した時点で打刻し、draft に戻しても保持する
    // (articles と同じ挙動。消すと再公開のたびに公開時刻がわからなくなる)
    const publishedAt =
      status === 'published' && current.published_at === null ? new Date() : current.published_at;

    await getDb()
      .updateTable('moments')
      .set({
        text: body.text ?? current.text,
        image_key: body.imageKey ?? current.image_key,
        fastener,
        fastener_color: fastenerColor,
        status,
        // 撮影時刻は写真差し替え時のみクライアントが送る。公開/下書きの切替では変わらない
        ...(body.capturedAt !== undefined ? { captured_at: body.capturedAt } : {}),
        published_at: publishedAt,
      })
      .where('moment_id', '=', id)
      .execute();
    const row = await findMoment(id, c.get('userId'));
    if (row === undefined) throw new HTTPException(404, { message: 'moment not found' });
    return c.json(toMomentDto(row), 200);
  })
  .openapi(deleteMomentRoute, async (c) => {
    const { id } = c.req.valid('param');
    const result = await getDb()
      .deleteFrom('moments')
      .where('moment_id', '=', id)
      .where('user_id', '=', c.get('userId'))
      .executeTakeFirst();
    if (result.numDeletedRows === 0n) {
      throw new HTTPException(404, { message: 'moment not found' });
    }
    return c.body(null, 204);
  });
