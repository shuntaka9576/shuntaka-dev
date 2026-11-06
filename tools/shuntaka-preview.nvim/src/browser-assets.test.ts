import { expect, test } from 'bun:test';
import { readMermaidRenderer } from './browser-assets.js';

test('共有描画処理を node_modules に依存しないブラウザ用 JS として配信できる', () => {
  const script = readMermaidRenderer();
  const scanned = new Bun.Transpiler({ loader: 'js' }).scan(script);
  expect(scanned.imports).toEqual([]);
  expect(scanned.exports).toContain('enhanceMermaid');
});
