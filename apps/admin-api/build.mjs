import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  minify: true,
  // mysql2 が optional dependency の cardinal を try/catch 内で require するため除外
  external: ['cardinal'],
  // ESM バンドルに含まれる CJS 依存 (mysql2 等) の require を解決するための shim
  banner: {
    js: "import { createRequire } from 'node:module';const require = createRequire(import.meta.url);",
  },
  logLevel: 'info',
});
