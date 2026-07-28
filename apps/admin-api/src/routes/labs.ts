import { createRoute } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import type { Selectable } from 'kysely';
import { getDb } from '../db/client.js';
import type { LabsTable } from '../db/types.js';
import { createRouter } from '../lib/router.js';
import {
  chapterDetailSchema,
  chapterParamSchema,
  labDetailSchema,
  labListSchema,
  labSlugParamSchema,
} from '../schemas/lab.js';

// labs は blog-api の webhook 同期が書き込むため read-only

const toLabDto = (row: Selectable<LabsTable>, chapterCount: number) => ({
  slug: row.slug,
  title: row.title,
  summary: row.summary,
  published: row.published === 1,
  chapterCount,
  updatedAt: row.updated_at.toISOString(),
});

const findLab = async (
  labSlug: string,
  userId: string,
): Promise<Selectable<LabsTable> | undefined> =>
  getDb()
    .selectFrom('labs')
    .selectAll()
    .where('slug', '=', labSlug)
    .where('user_id', '=', userId)
    .executeTakeFirst();

const listChapters = async (labId: string) => {
  const rows = await getDb()
    .selectFrom('lab_chapters')
    .select(['slug', 'title', 'position'])
    .where('lab_id', '=', labId)
    .orderBy('position', 'asc')
    .execute();
  return rows.map((row) => ({ slug: row.slug, title: row.title, position: row.position }));
};

const listRoute = createRoute({
  method: 'get',
  path: '/labs',
  responses: {
    200: {
      content: { 'application/json': { schema: labListSchema } },
      description: 'lab (本) の一覧',
    },
  },
});

const detailRoute = createRoute({
  method: 'get',
  path: '/labs/{labSlug}',
  request: { params: labSlugParamSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: labDetailSchema } },
      description: 'lab の詳細と章一覧',
    },
  },
});

const chapterRoute = createRoute({
  method: 'get',
  path: '/labs/{labSlug}/chapters/{chapterSlug}',
  request: { params: chapterParamSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: chapterDetailSchema } },
      description: '章本文 (content_html)',
    },
  },
});

export const labRoutes = createRouter()
  .openapi(listRoute, async (c) => {
    const rows = await getDb()
      .selectFrom('labs')
      .selectAll('labs')
      .select((eb) =>
        eb
          .selectFrom('lab_chapters')
          .whereRef('lab_chapters.lab_id', '=', 'labs.lab_id')
          .select((inner) => inner.fn.countAll<number>().as('c'))
          .as('chapterCount'),
      )
      .where('labs.user_id', '=', c.get('userId'))
      .orderBy('labs.slug', 'asc')
      .execute();
    return c.json({ labs: rows.map((row) => toLabDto(row, Number(row.chapterCount ?? 0))) }, 200);
  })
  .openapi(detailRoute, async (c) => {
    const { labSlug } = c.req.valid('param');
    const lab = await findLab(labSlug, c.get('userId'));
    if (!lab) throw new HTTPException(404, { message: 'lab_not_found' });
    const chapters = await listChapters(lab.lab_id);
    return c.json({ lab: toLabDto(lab, chapters.length), chapters }, 200);
  })
  .openapi(chapterRoute, async (c) => {
    const { labSlug, chapterSlug } = c.req.valid('param');
    const lab = await findLab(labSlug, c.get('userId'));
    if (!lab) throw new HTTPException(404, { message: 'lab_not_found' });
    const chapters = await listChapters(lab.lab_id);
    const chapterRow = await getDb()
      .selectFrom('lab_chapters')
      .select(['slug', 'title', 'position', 'content_html'])
      .where('lab_id', '=', lab.lab_id)
      .where('slug', '=', chapterSlug)
      .executeTakeFirst();
    if (!chapterRow) throw new HTTPException(404, { message: 'chapter_not_found' });
    return c.json(
      {
        lab: toLabDto(lab, chapters.length),
        chapters,
        chapter: {
          slug: chapterRow.slug,
          title: chapterRow.title,
          position: chapterRow.position,
          contentHtml: chapterRow.content_html ?? '',
        },
      },
      200,
    );
  });
