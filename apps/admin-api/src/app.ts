import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { csrfGuard } from './auth/csrf.js';
import { sessionAuth } from './auth/middleware.js';
import { createRouter } from './lib/router.js';
import { authRoutes } from './routes/auth.js';
import { imageRoutes } from './routes/images.js';
import { labRoutes } from './routes/labs.js';
import { meRoutes } from './routes/me.js';
import { momentRoutes } from './routes/moments.js';
import { todoRoutes } from './routes/todo.js';

// CloudFront 側で prefix strip をしないため basePath で /api を持つ
export const app = createRouter().basePath('/api');

app.use(csrfGuard);
// /auth/* 以外は認証必須。パスを明示して素通りを防ぐ
app.use('/me', sessionAuth);
app.use('/moments', sessionAuth);
app.use('/moments/*', sessionAuth);
app.use('/images/*', sessionAuth);
app.use('/labs', sessionAuth);
app.use('/labs/*', sessionAuth);
app.use('/todo', sessionAuth);
app.use('/todo/*', sessionAuth);

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status as ContentfulStatusCode);
  }
  console.error(err);
  return c.json({ error: 'internal_error' }, 500);
});

const routes = app
  .route('/', authRoutes)
  .route('/', meRoutes)
  .route('/', momentRoutes)
  .route('/', imageRoutes)
  .route('/', labRoutes)
  .route('/', todoRoutes);

// admin-web が hc<AppType> で型共有するための export
export type AppType = typeof routes;
