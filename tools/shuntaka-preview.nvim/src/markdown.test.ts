import { afterEach, describe, expect, test } from 'bun:test';
import { renderMarkdown } from './markdown.js';

// コミット済みの pkg/（release ビルド）をサーバー本体と同じ経路でロードして検証する

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(handler: () => Response | Promise<Response>): { calls: () => number } {
  let count = 0;
  globalThis.fetch = ((..._args: Parameters<typeof fetch>) => {
    count += 1;
    return Promise.resolve(handler());
  }) as typeof fetch;
  return { calls: () => count };
}

describe('renderMarkdown', () => {
  test('外部リソース無しの Markdown が本番同等の HTML に変換される', async () => {
    const html = await renderMarkdown('# 見出し\n\n本文');
    expect(html).toContain('見出し');
    expect(html).toContain('<p>本文</p>');
  });

  test('シンタックスハイライトが inline style で埋め込まれる', async () => {
    const html = await renderMarkdown('```rust\nfn main() {}\n```');
    expect(html).toContain('style="background-color:');
    expect(html).toContain('<span style="color:');
  });

  test('カスタムコンテナ (:::message) が変換される', async () => {
    const html = await renderMarkdown('::: message info\nテスト\n:::');
    expect(html).toContain('class="message info"');
  });

  test('OGP フェッチ成功はプロセス寿命でキャッシュされ 2 回目以降フェッチしない', async () => {
    const fetched = mockFetch(
      () =>
        new Response(
          '<html><head><meta property="og:title" content="Cached Title"></head></html>',
          { status: 200 },
        ),
    );
    const md = 'https://example.com/cache-hit';

    const first = await renderMarkdown(md);
    expect(first).toContain('link-card');
    expect(first).toContain('Cached Title');
    expect(fetched.calls()).toBe(1);

    const second = await renderMarkdown(md);
    expect(second).toContain('Cached Title');
    expect(fetched.calls()).toBe(1);
  });

  test('フェッチ失敗は短 TTL キャッシュされ、変換は元 URL のまま継続する', async () => {
    const fetched = mockFetch(() => {
      throw new Error('network down');
    });
    const md = 'https://example.com/cache-miss';

    const first = await renderMarkdown(md);
    expect(first).not.toContain('link-card');
    expect(first).toContain('https://example.com/cache-miss');
    expect(fetched.calls()).toBe(1);

    // TTL (30 秒) 内の再変換では再フェッチしない
    await renderMarkdown(md);
    expect(fetched.calls()).toBe(1);
  });
});
