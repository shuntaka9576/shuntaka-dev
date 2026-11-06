import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// 型だけを消して配信する。runtime import を持たないため、lazy.nvim の
// node_modules がない clone でも Bun だけで本番と同じ描画処理を使える。
export function readMermaidRenderer(): string {
  const source = readFileSync(
    join(import.meta.dir, '../../../apps/web/src/lib/mermaid-renderer.ts'),
    'utf-8',
  );
  return new Bun.Transpiler({ loader: 'ts' }).transformSync(source);
}
