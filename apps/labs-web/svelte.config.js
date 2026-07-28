import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    // S3 + CloudFront 配信の SPA。非ファイル URI は CloudFront Function が
    // /labs/index.html に rewrite する前提（fallback がそのシェルになる）
    adapter: adapter({ fallback: 'index.html' }),
    // admin.<fqdn>/labs 配下に合成されるため base を固定
    paths: { base: '/labs' },
  },
};

export default config;
