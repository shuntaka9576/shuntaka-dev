import { describe, expect, test } from 'bun:test';

// wasm-pack で生成した pkg（`bun run test` が build:wasm:dev を先に実行する）を
// バッチ本体と同じ経路でロードし、wasm バイナリ + JS グルーの実物を検証する
type WasmModule = {
  collectResourceUrls: (markdown: string) => string[];
  convertMarkdownWithResources: (markdown: string, resources: Record<string, string>) => string;
};

const pkgUrl = new URL('../pkg/markdown.js', import.meta.url).href;
const mod = (await import(pkgUrl)) as Record<string, unknown>;
const wasm = (mod.collectResourceUrls ? mod : mod.default) as WasmModule;

describe('collectResourceUrls', () => {
  test('GitHub blob は raw URL に変換され、OGP 対象 URL はそのまま列挙される', () => {
    const md = [
      'https://github.com/owner/repo/blob/main/notes.txt#L1-L2',
      '',
      'https://example.com/page',
      '',
      'https://x.com/user/status/1234567890',
      '',
      '```',
      'https://example.com/in-code-block',
      '```',
      '',
    ].join('\n');

    expect(wasm.collectResourceUrls(md)).toEqual([
      'https://raw.githubusercontent.com/owner/repo/main/notes.txt',
      'https://example.com/page',
    ]);
  });

  test('同じ URL は重複せず 1 回だけ列挙される', () => {
    const md = 'https://example.com/page\n\nhttps://example.com/page';
    expect(wasm.collectResourceUrls(md)).toEqual(['https://example.com/page']);
  });

  test('フェッチ対象が無い記事は空配列', () => {
    expect(wasm.collectResourceUrls('# Title\n\n本文のみ')).toEqual([]);
  });
});

describe('convertMarkdownWithResources', () => {
  test('GitHub 埋め込み: 注入したコードから指定行だけ描画される', () => {
    const md = 'https://github.com/owner/repo/blob/main/notes.txt#L1-L2';
    const html = wasm.convertMarkdownWithResources(md, {
      'https://raw.githubusercontent.com/owner/repo/main/notes.txt': 'alpha\nbravo\ncharlie',
    });
    expect(html).toContain('github-embed-card');
    expect(html).toContain('alpha');
    expect(html).toContain('bravo');
    expect(html).not.toContain('charlie');
  });

  test('リンクカード: 注入した OGP HTML からタイトルが描画される', () => {
    const md = 'https://example.com/page';
    const html = wasm.convertMarkdownWithResources(md, {
      'https://example.com/page':
        '<html><head><meta property="og:title" content="Example Title"><meta property="og:description" content="Example Description"></head></html>',
    });
    expect(html).toContain('link-card');
    expect(html).toContain('Example Title');
    expect(html).toContain('Example Description');
  });

  test('リソース未注入の URL はリンクカード化せず元の URL を残す', () => {
    const html = wasm.convertMarkdownWithResources('https://example.com/page', {});
    expect(html).not.toContain('link-card');
    expect(html).toContain('https://example.com/page');
  });

  test('シンタックスハイライトが wasm (fancy-regex) でも動作する', () => {
    const html = wasm.convertMarkdownWithResources('```rust\nfn main() {}\n```', {});
    expect(html).toContain('style="background-color:');
    expect(html).toContain('<span style="color:');
    expect(html).toContain('main');
  });

  test('カスタムコンテナ (:::message) が変換される', () => {
    const html = wasm.convertMarkdownWithResources('::: message info\nテスト\n:::', {});
    expect(html).toContain('class="message info"');
  });

  test('resources に不正な型を渡すとエラーになる', () => {
    expect(() =>
      wasm.convertMarkdownWithResources('# Title', 123 as unknown as Record<string, string>),
    ).toThrow();
  });
});
