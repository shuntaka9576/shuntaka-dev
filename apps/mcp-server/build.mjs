import { build } from 'esbuild';

// Web Functions の runtime は index.mjs を読み込むだけなので、依存ごと 1 ファイルにまとめる
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  minify: true,
  // ESM バンドルに含まれる CJS 依存の require を解決するための shim
  banner: {
    js: "import { createRequire } from 'node:module';const require = createRequire(import.meta.url);",
  },
  logLevel: 'info',
});
