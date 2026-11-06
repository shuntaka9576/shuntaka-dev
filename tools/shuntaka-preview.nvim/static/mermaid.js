import { enhanceMermaid } from '/mermaid-renderer.js';

let generation = 0;
let cleanup;
let library;

async function refresh() {
  const currentGeneration = ++generation;
  cleanup?.();
  cleanup = undefined;
  const content = document.getElementById('content');
  if (!content?.querySelector('pre[lang="mermaid"]')) return;

  try {
    // node_modules 不要。図のある記事でだけ固定バージョンを読み込む。
    library ??= import('https://cdn.jsdelivr.net/npm/mermaid@12.3.0/dist/mermaid.esm.min.mjs');
    const { default: mermaid } = await library;
    if (currentGeneration !== generation) return;
    cleanup = enhanceMermaid(content, mermaid);
  } catch {
    library = undefined;
    if (currentGeneration !== generation) return;
    const message = document.createElement('p');
    message.textContent = 'Mermaid を読み込めませんでした。ネットワーク接続を確認してください。';
    content.prepend(message);
    cleanup = () => message.remove();
  }
}

document.addEventListener('preview-content-updated', () => void refresh());
window.addEventListener('pagehide', () => {
  ++generation;
  cleanup?.();
});
void refresh();
