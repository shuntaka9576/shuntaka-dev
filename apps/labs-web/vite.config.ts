import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// ポートは worktree ごとに .env.local (wt.toml pre-start が生成) で採番される。
// fallback は main worktree の既定値 (scripts/port.sh と揃える)
const port = Number(process.env.LABS_WEB_PORT ?? 43006);
const apiPort = Number(process.env.LABS_API_PORT ?? 43007);

export default defineConfig({
  plugins: [
    tailwindcss(),
    sveltekit({
      preprocess: vitePreprocess(),
      // S3 + CloudFront 配信の SPA。非ファイル URI は CloudFront Function が
      // /labs/index.html に rewrite する前提（fallback がそのシェルになる）
      adapter: adapter({ fallback: 'index.html' }),
      // admin.<fqdn>/labs 配下に合成されるため base を固定
      paths: { base: '/labs' },
    }),
  ],
  server: {
    port,
    strictPort: true,
    // 本番は同一オリジンの CloudFront が /api/* と /lab-assets/* を振り分ける。
    // ローカルはプレビュー API (preview/server.ts) に proxy して同じパス構造を再現する
    proxy: {
      '/api': `http://localhost:${apiPort}`,
      '/lab-assets': `http://localhost:${apiPort}`,
    },
  },
});
