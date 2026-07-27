// blog-api の markdown crate を wasm-pack でビルドした成果物（pkg/ はコミット済み）。
// 変換ロジックを本番 API と共有するため、TS 側で再実装せず wasm を呼ぶ。
// 静的 import にすると pkg 未生成時に type-check が落ちるので動的 import にしている。
type WasmModule = {
  collectResourceUrls: (markdown: string) => string[];
  convertMarkdownWithResources: (markdown: string, resources: Record<string, string>) => string;
};

let wasmPromise: Promise<WasmModule> | undefined;

async function loadWasm(): Promise<WasmModule> {
  const pkgUrl = new URL('../pkg/markdown.js', import.meta.url).href;
  try {
    const mod = (await import(pkgUrl)) as Record<string, unknown>;
    const impl = (mod.collectResourceUrls ? mod : mod.default) as WasmModule | undefined;
    if (!impl?.collectResourceUrls || !impl?.convertMarkdownWithResources) {
      throw new Error('exports not found');
    }
    return impl;
  } catch (e) {
    throw new Error(
      `pkg/markdown.js をロードできない。先に \`bun run build:wasm\` を実行すること (${e instanceof Error ? e.message : String(e)})`,
    );
  }
}

// ライブプレビュー中に同じ URL を打鍵ごとにフェッチしないためのキャッシュ。
// 成功はプロセス寿命で保持し、失敗のみ短 TTL で再試行する（URL タイポ修正後に復帰できるように）
const resourceCache = new Map<string, string>();
const failedAt = new Map<string, number>();
const FAIL_RETRY_MS = 30_000;

// ureq (markdown crate native 実装) と同じ 5 秒タイムアウト・UA でフェッチする。
// 失敗した URL はマップに入れない → wasm 側は元の URL をそのまま残すフォールバックに入る
export async function renderMarkdown(markdown: string, timeoutMs = 5000): Promise<string> {
  wasmPromise ??= loadWasm();
  const wasm = await wasmPromise;

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
