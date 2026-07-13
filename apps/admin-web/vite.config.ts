import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// wt.toml が worktree ごとに hash_port で採番する (未設定時は admin-backend の 43001 と対の 43002)
const port = Number(process.env.ADMIN_WEB_PORT ?? 43002);
const apiPort = Number(process.env.ADMIN_API_PORT ?? 43001);

export default defineConfig({
  plugins: [
    // ルーティングは FSD の app レイヤーの責務。routes と生成物 routeTree.gen.ts を
    // app/ 配下に閉じ込める。tanstackRouter は react より前に置く必要がある
    tanstackRouter({
      target: 'react',
      routesDirectory: './src/app/routes',
      generatedRouteTree: './src/app/routeTree.gen.ts',
    }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port,
    proxy: {
      // admin-backend は basePath('/api') を持つため prefix は剥がさずそのまま転送する
      // (本番 CloudFront も同じパス構造)
      '/api': {
        target: `http://localhost:${apiPort}`,
        changeOrigin: true,
      },
    },
  },
});
