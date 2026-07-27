// 変換ロジックは packages/markdown-wasm (pkg/ コミット済み) に集約している。
// lazy.nvim で入れたマシンでは `bun install` を実行せず node_modules が無いため、
// workspace 名ではなく相対パスで import する (bun がそのまま TS を解決できる)
import { loadWasm } from '../../../packages/markdown-wasm/src/index.js';

// ライブプレビュー中に同じ URL を打鍵ごとにフェッチしないためのキャッシュ。
// 成功はプロセス寿命で保持し、失敗のみ短 TTL で再試行する（URL タイポ修正後に復帰できるように）
const resourceCache = new Map<string, string>();
const failedAt = new Map<string, number>();
const FAIL_RETRY_MS = 30_000;

// ureq (markdown crate native 実装) と同じ 5 秒タイムアウト・UA でフェッチする。
// 失敗した URL はマップに入れない → wasm 側は元の URL をそのまま残すフォールバックに入る
export async function renderMarkdown(markdown: string, timeoutMs = 5000): Promise<string> {
  const wasm = await loadWasm();

  const urls = wasm.collectResourceUrls(markdown);
  const now = Date.now();
  const toFetch = urls.filter(
    (url) => !resourceCache.has(url) && now - (failedAt.get(url) ?? 0) > FAIL_RETRY_MS,
  );
  await Promise.all(
    toFetch.map(async (url) => {
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LinkCardBot/1.0)' },
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'follow',
        });
        if (res.ok) {
          resourceCache.set(url, await res.text());
        } else {
          failedAt.set(url, Date.now());
        }
      } catch {
        failedAt.set(url, Date.now());
      }
    }),
  );

  const resources: Record<string, string> = {};
  for (const url of urls) {
    const cached = resourceCache.get(url);
    if (cached !== undefined) {
      resources[url] = cached;
    }
  }
  return wasm.convertMarkdownWithResources(markdown, resources);
}
