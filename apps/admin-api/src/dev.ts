import { serve } from '@hono/node-server';
import { Scalar } from '@scalar/hono-api-reference';
import { Hono } from 'hono';

// dev の env は bare clone 直下の .envrc (direnv) から継承される。
// worktree ごとのポート等は .env.local が上書きするので任意で読む
try {
  process.loadEnvFile('.env.local');
} catch {
  // .env.local が無ければ direnv / シェルの環境変数のみで動く
}

const { app } = await import('./app.js');

// /openapi.json と Scalar /doc はローカル開発サーバ限定 (Lambda の index.ts には載せない)。
// basePath('/api') 配下に生えるため実 URL は /api/openapi.json と /api/doc
app.doc('/openapi.json', {
  openapi: '3.0.0',
  info: { title: 'shuntaka-dev admin API', version: '0.1.0' },
});
app.get('/doc', Scalar({ url: '/api/openapi.json' }));

// 全ルートが /api 配下のため、素の / を開いたときは Scalar へ誘導する
const devApp = new Hono();
devApp.get('/', (c) => c.redirect('/api/doc'));
devApp.route('/', app);

// wt.toml が worktree ごとに hash_port で採番する。フォールバックは他ツールと
// 被りにくい 43001 (3000 番台は Next.js 等が使うため避ける)
const port = Number(process.env.ADMIN_API_PORT ?? 43001);

serve({ fetch: devApp.fetch, port }, (info) => {
  console.log(`admin-api dev server: http://localhost:${info.port}/api/doc`);
});
