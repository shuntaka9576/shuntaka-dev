import { existsSync } from 'node:fs';
import { afterEach, describe, expect, test } from 'bun:test';
import { fetchResources, importWasmPkg, loadWasm, type WasmModule } from './index.js';

// 同一スイートを「コミット済み pkg (release)」と「CI で都度ビルドする .pkg-fresh (dev)」の
// 両方に対して実行する。wasm バイナリはビルドマシンの絶対パスを含みバイト比較が
// できないため、挙動の一致でコミット済み pkg の鮮度を担保する
// (`bun run test` が build:wasm:fresh を先に実行する)
const targets: { name: string; wasm: WasmModule }[] = [
  { name: 'コミット済み pkg', wasm: await loadWasm() },
];
const freshUrl = new URL('../.pkg-fresh/markdown.js', import.meta.url);
if (existsSync(freshUrl)) {
  targets.push({ name: 'fresh ビルド', wasm: await importWasmPkg(freshUrl.href) });
}

for (const { name, wasm } of targets) {
  describe(`collectResourceUrls (${name})`, () => {
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

  describe(`convertMarkdownWithResources (${name})`, () => {
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

    test('インライン数式と別行数式が KaTeX 描画用の要素に変換される', () => {
      const html = wasm.convertMarkdownWithResources(
        'inline $x^2 + y^2$\n\n$$\n\\frac{1}{2}\\pi r^2\n$$',
        {},
      );
      expect(html).toContain('<span data-math-style="inline">x^2 + y^2</span>');
      expect(html).toContain('<span data-math-style="display">\n\\frac{1}{2}\\pi r^2\n</span>');
    });

    test('カスタムコンテナ (:::message) が変換される', () => {
      const html = wasm.convertMarkdownWithResources('::: message info\nテスト\n:::', {});
      expect(html).toContain('class="message info"');
    });

    test('details 内へ message をネストできる', () => {
      const html = wasm.convertMarkdownWithResources(
        '::::details 解答\n\n本文\n\n:::message\n\n補足\n:::\n::::',
        {},
      );
      expect(html).toContain('<details><summary>解答</summary>');
      expect(html).toContain('<div class="message "><p>補足</p>');
      expect(html).toContain('</div></details>');
      expect(html).not.toContain('::::');
    });

    test('ウィジェット記法 (:::widget) が data-payload に base64 encode される', () => {
      const html = wasm.convertMarkdownWithResources(
        ':::widget engine-steps\nnum: 1\ntitle: "テスト"\n:::',
        {},
      );
      expect(html).toContain('class="lab-widget"');
      expect(html).toContain('data-widget="engine-steps"');
      const payload = html.match(/data-payload="([^"]+)"/)?.[1];
      expect(Buffer.from(payload ?? '', 'base64').toString('utf-8')).toBe(
        'num: 1\ntitle: "テスト"',
      );
    });

    test('resources に不正な型を渡すとエラーになる', () => {
      expect(() =>
        wasm.convertMarkdownWithResources('# Title', 123 as unknown as Record<string, string>),
      ).toThrow();
    });
  });
}

describe('fetchResources', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('成功した URL だけマップに入り、失敗はスキップされる', async () => {
    globalThis.fetch = ((url: string) => {
      if (url.includes('ok')) {
        return Promise.resolve(new Response('<html>ok</html>', { status: 200 }));
      }
      return Promise.resolve(new Response('ng', { status: 500 }));
    }) as typeof fetch;

    const resources = await fetchResources(['https://example.com/ok', 'https://example.com/ng']);
    expect(resources).toEqual({ 'https://example.com/ok': '<html>ok</html>' });
  });
});
