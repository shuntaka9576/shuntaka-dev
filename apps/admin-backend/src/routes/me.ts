import { createRoute, z } from '@hono/zod-openapi';
import { createRouter } from '../lib/router.js';

const meRoute = createRoute({
  method: 'get',
  path: '/me',
  responses: {
    200: {
      content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } },
      description: 'セッション検証の疎通確認 (FE の auth guard 用)',
    },
  },
});

export const meRoutes = createRouter().openapi(meRoute, (c) => c.json({ ok: true }, 200));
