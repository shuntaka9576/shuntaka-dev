// blog-api の markdown crate を wasm-pack でビルドした成果物 (pkg/) の共有ローダー。
// pkg/ は release ビルドをコミットしてあり、利用側はビルド不要で import できる。
// crate を変更したら `bun run build:wasm` で再生成して pkg/ の差分をコミットすること
// (挙動が変わる変更はテストも更新される前提で、古い pkg のまま だと
//  コミット済み pkg に対するテストが落ちて再ビルドが強制される)。
export type WasmModule = {
  collectResourceUrls: (markdown: string) => string[];
  convertMarkdownWithResources: (markdown: string, resources: Record<string, string>) => string;
};

// 静的 import にすると pkg 未生成時に type-check が落ちるので動的 import にしている
export async function importWasmPkg(pkgJsUrl: string): Promise<WasmModule> {
  try {
    const mod = (await import(pkgJsUrl)) as Record<string, unknown>;
    const impl = (mod.collectResourceUrls ? mod : mod.default) as WasmModule | undefined;
    if (!impl?.collectResourceUrls || !impl?.convertMarkdownWithResources) {
      throw new Error('exports not found');
    }
    return impl;
  } catch (e) {
    throw new Error(
      `${pkgJsUrl} をロードできない。先に \`bun run build:wasm\` を実行すること (${e instanceof Error ? e.message : String(e)})`,
    );
  }
}

let wasmPromise: Promise<WasmModule> | undefined;

export function loadWasm(): Promise<WasmModule> {
  wasmPromise ??= importWasmPkg(new URL('../pkg/markdown.js', import.meta.url).href);
  return wasmPromise;
}

// ureq (markdown crate native 実装) と同じ 5 秒タイムアウト・UA でフェッチする。
// 失敗した URL はマップに入れない → wasm 側は元の URL をそのまま残すフォールバックに入る
export async function fetchResources(
  urls: string[],
  timeoutMs = 5000,
): Promise<Record<string, string>> {
  const resources: Record<string, string> = {};
  await Promise.all(
    urls.map(async (url) => {
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LinkCardBot/1.0)' },
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'follow',
        });
        if (res.ok) {
          resources[url] = await res.text();
        }
      } catch {
        // フェッチ失敗はスキップ（変換側でフォールバック）
      }
    }),
  );
  return resources;
}
