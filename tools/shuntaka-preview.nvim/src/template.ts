import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// モノレポ内の実ファイルを直接読む（lazy.nvim はリポジトリ全体を clone するため常に存在する）
const GLOBALS_CSS_PATH = join(import.meta.dir, '../../../apps/web/src/app/globals.css');

// 先頭の @import 'tailwindcss' と @theme ブロックはプレーン CSS ではないため除去する。
// 残りは素の CSS（:root 変数、.prose、.message 等）なのでブラウザがそのまま解釈できる
export function stripTailwindDirectives(css: string): string {
  return css
    .replace(/^@import\s+['"]tailwindcss['"];\s*\n/m, '')
    .replace(/@theme\s*\{[^}]*\}\s*\n?/, '');
}

// プレビュー中に globals.css を編集して見た目を確認できるよう毎回読み直す
export function readGlobalsCss(): string {
  return stripTailwindDirectives(readFileSync(GLOBALS_CSS_PATH, 'utf-8'));
}

// 外側ページ。左に記事一覧サイドバー、右に記事を描画する iframe (/view) を持ち、
// pc / mobile のビューポート切り替えツールバーを重ねる。iframe の幅を変えることで
// globals.css の media query が本番同様に効く。WS 受信・一覧描画・iframe への反映は
// client.js (親側) が行う
export function renderShellPage(): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>shuntaka-preview</title>
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="stylesheet" href="/globals.css">
<style>
  body { margin: 0; background: var(--color-bg); color: var(--color-text); }
  .layout { display: flex; height: 100vh; }
  .article-list {
    width: 280px; flex: none; display: flex; flex-direction: column;
    background: var(--color-surface);
    border-right: 1px solid var(--color-border-subtle);
  }
  .article-list-header {
    padding: 10px 12px; border-bottom: 1px solid var(--color-border-subtle);
  }
  .article-list-header select {
    width: 100%; font-size: 12px; padding: 4px 6px;
    background: var(--color-bg); color: var(--color-text);
    border: 1px solid var(--color-border-subtle); border-radius: 6px;
  }
  .article-list ul { list-style: none; margin: 0; padding: 0; overflow-y: auto; flex: 1; }
  .article-list li {
    padding: 10px 12px; border-bottom: 1px solid var(--color-border-subtle);
    border-left: 3px solid transparent; cursor: pointer;
  }
  .article-list li:hover { background: var(--color-bg); }
  .article-list li.active { border-left-color: var(--color-accent); }
  .article-list .item-title { font-size: 13px; line-height: 1.4; word-break: break-all; }
  .article-list .item-dates { font-size: 11px; color: var(--color-text-muted); margin-top: 4px; }
  .preview-main { flex: 1; min-width: 0; }
  #view { display: block; width: 100%; height: 100vh; margin: 0 auto; border: 0; }
  body[data-viewport='mobile'] #view {
    width: 390px;
    border-left: 1px solid var(--color-border-subtle);
    border-right: 1px solid var(--color-border-subtle);
  }
  .viewport-toolbar {
    position: fixed; top: 12px; right: 12px; z-index: 10;
    display: flex; gap: 4px; padding: 4px;
    background: var(--color-surface);
    border: 1px solid var(--color-border-subtle); border-radius: 9999px;
  }
  .viewport-toolbar button {
    font-size: 12px; padding: 2px 10px; border: 0; border-radius: 9999px;
    background: transparent; color: var(--color-text-muted); cursor: pointer;
  }
  .viewport-toolbar button.active { background: var(--color-accent); color: #fff; }
</style>
</head>
<body data-viewport="pc">
<div class="layout">
  <aside class="article-list">
    <div class="article-list-header">
      <select id="sort" title="sort">
        <option value="updated">更新日が新しい順</option>
        <option value="created">作成日が新しい順</option>
        <option value="name">ファイル名順</option>
      </select>
    </div>
    <ul id="articles"></ul>
  </aside>
  <main class="preview-main">
    <iframe id="view" src="/view" title="preview"></iframe>
  </main>
</div>
<div class="viewport-toolbar">
  <button type="button" data-viewport-mode="pc">pc</button>
  <button type="button" data-viewport-mode="mobile">mobile</button>
</div>
<script src="/client.js"></script>
</body>
</html>`;
}

// iframe 内の記事ページ。記事ページ (apps/web) と同じ
// article-body > article-content + right-sidebar (目次) の構造を、本番と同じ
// コンテナ幅 (--layout-max) で再現する。article-header 等のサイト chrome は対象外。
// 目次は TableOfContents.tsx を移植した toc.js が組み立てる。
// 変換済み HTML を初期表示として埋め込み、リロード時に WS 接続を待たず内容を出す
export function renderViewPage(initialHtml = ''): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>shuntaka-preview view</title>
<link rel="stylesheet" href="/globals.css">
<style>
  body { margin: 0; background: var(--color-bg); color: var(--color-text); }
  .preview-shell { max-width: var(--layout-max); margin: 0 auto; padding: 2rem; }
  @media (max-width: 576px) {
    .preview-shell { padding: 1rem 0.75rem; }
  }
</style>
</head>
<body>
<div class="preview-shell">
  <div id="article-body" class="article-body">
    <article class="article-content">
      <div class="article-content-wrapper">
        <div id="content" class="prose max-w-none">${initialHtml}</div>
      </div>
    </article>
    <aside id="sidebar" class="right-sidebar">
      <button type="button" id="toc-mobile-trigger" class="toc-mobile-trigger" aria-label="目次を開く">
        目次
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg>
      </button>
      <dialog id="toc-mobile-dialog" class="toc-mobile-dialog">
        <div id="toc-mobile-list" tabindex="-1" class="toc toc-mobile-list"></div>
      </dialog>
      <div id="toc-desktop" class="toc toc-desktop"></div>
    </aside>
  </div>
</div>
<script src="/toc.js"></script>
</body>
</html>`;
}
