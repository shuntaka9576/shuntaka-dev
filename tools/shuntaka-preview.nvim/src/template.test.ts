import { describe, expect, test } from 'bun:test';
import {
  readGlobalsCss,
  renderShellPage,
  renderViewPage,
  stripTailwindDirectives,
} from './template.js';

describe('stripTailwindDirectives', () => {
  test('@import tailwindcss と @theme ブロックを除去し、他のルールは残す', () => {
    const css = [
      "@import 'tailwindcss';",
      '',
      '@theme {',
      '  --font-weight-bold: 600;',
      '}',
      '',
      ':root {',
      '  --color-bg: #f7fafc;',
      '}',
      '.prose h1 { font-size: 1.7em; }',
    ].join('\n');

    const stripped = stripTailwindDirectives(css);
    expect(stripped).not.toContain('@import');
    expect(stripped).not.toContain('@theme');
    expect(stripped).toContain('--color-bg: #f7fafc;');
    expect(stripped).toContain('.prose h1 { font-size: 1.7em; }');
  });
});

describe('readGlobalsCss', () => {
  test('apps/web の実 CSS を読み込み、記事スタイルが含まれる', () => {
    const css = readGlobalsCss();
    expect(css).toContain('.article-content');
    expect(css).toContain('.prose');
    expect(css).not.toContain('@theme');
    expect(css).not.toContain("@import 'tailwindcss'");
  });
});

describe('renderShellPage', () => {
  test('記事一覧・pc/mobile 切り替え・iframe・favicon を持つ', () => {
    const html = renderShellPage();
    expect(html).toContain('<ul id="articles">');
    expect(html).toContain('<select id="sort"');
    expect(html).toContain('data-viewport-mode="pc"');
    expect(html).toContain('data-viewport-mode="mobile"');
    expect(html).toContain('<iframe id="view" src="/view"');
    expect(html).toContain('href="/favicon.png"');
    expect(html).toContain('/client.js');
  });
});

describe('renderViewPage', () => {
  test('記事ページと同じ構造 (article-body > article-content + right-sidebar 目次) を持つ', () => {
    const html = renderViewPage();
    expect(html).toContain('class="article-body"');
    expect(html).toContain('class="article-content"');
    expect(html).toContain('class="article-content-wrapper"');
    expect(html).toContain('id="content" class="prose max-w-none"');
    expect(html).toContain('class="right-sidebar"');
    expect(html).toContain('class="toc toc-desktop"');
    expect(html).toContain('class="toc-mobile-trigger"');
    expect(html).toContain('max-width: var(--layout-max)');
    expect(html).toContain('/globals.css');
    expect(html).toContain('/toc.js');
  });

  test('変換済み HTML を初期表示として埋め込める', () => {
    const html = renderViewPage('<p>初期表示</p>');
    expect(html).toContain('<div id="content" class="prose max-w-none"><p>初期表示</p></div>');
  });
});
