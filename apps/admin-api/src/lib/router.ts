import { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../auth/middleware.js';

// バリデーションエラーを 400 に統一する defaultHook 付きのルーター factory。
// ルートを持つ OpenAPIHono は必ずこれで作る
export const createRouter = (): OpenAPIHono<AppEnv> =>
  new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ error: 'validation_error', issues: result.error.issues }, 400);
      }
      return undefined;
    },
  });
