import { program } from 'commander';
import mysql from 'mysql2/promise';

// blog-api の markdown crate を wasm-pack でビルドした成果物（pkg/ は gitignore 済み）。
// 変換ロジックを API と共有するため、TS 側で再実装せず wasm を呼ぶ。
// 静的 import にすると pkg 未生成時に type-check が落ちるので動的 import にしている。
type WasmModule = {
  collectResourceUrls: (markdown: string) => string[];
  convertMarkdownWithResources: (markdown: string, resources: Record<string, string>) => string;
};

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

// ureq (markdown crate native 実装) と同じ 5 秒タイムアウト・UA でフェッチする。
// 失敗した URL はマップに入れない → wasm 側は元の URL をそのまま残すフォールバックに入る
async function fetchResources(urls: string[], timeoutMs: number): Promise<Record<string, string>> {
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

interface ArticleRow extends mysql.RowDataPacket {
  article_id: string;
  slug: string;
  content: string;
}

async function main(): Promise<void> {
  program
    .name('content-html-backfill')
    .description(
      'articles.content_html を markdown crate (wasm) で生成して埋め戻す。updated_at は変更しない',
    )
    .requiredOption(
      '--endpoint <url>',
      'TiDB 接続 URL (例: mysql://root@tidb.<TAILNET>:4000/blog_dev)',
    )
    .option('--all', 'content_html が埋まっている記事も再生成する', false)
    .option('--slug <slug>', '指定 slug の記事だけ処理する')
    .option('--dry-run', 'UPDATE せず変換結果のサイズだけ表示する', false)
    .option('--timeout <ms>', 'リンクカード等の外部フェッチのタイムアウト (ms)', '5000')
    .parse();

  const opts = program.opts<{
    endpoint: string;
    all: boolean;
    slug?: string;
    dryRun: boolean;
    timeout: string;
  }>();
  const timeoutMs = Number(opts.timeout);

  const wasm = await loadWasm();
  const conn = await mysql.createConnection(opts.endpoint);

  try {
    const conditions: string[] = [];
    const params: string[] = [];
    if (!opts.all) {
      conditions.push('content_html IS NULL');
    }
    if (opts.slug) {
      conditions.push('slug = ?');
      params.push(opts.slug);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const [rows] = await conn.execute<ArticleRow[]>(
      `SELECT article_id, slug, content FROM articles ${where}`,
      params,
    );

    console.log(`対象記事: ${rows.length} 件${opts.dryRun ? ' (dry-run)' : ''}`);

    let succeeded = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        const urls = wasm.collectResourceUrls(row.content);
        const resources = await fetchResources(urls, timeoutMs);
        const fetchedCount = Object.keys(resources).length;
        const html = wasm.convertMarkdownWithResources(row.content, resources);

        if (opts.dryRun) {
          console.log(
            `  [dry-run] ${row.slug}: fetch ${fetchedCount}/${urls.length}, html ${html.length} 文字`,
          );
        } else {
          // updated_at は ON UPDATE を付けていないので、この UPDATE では変化しない
          await conn.execute('UPDATE articles SET content_html = ? WHERE article_id = ?', [
            html,
            row.article_id,
          ]);
          console.log(
            `  ${row.slug}: fetch ${fetchedCount}/${urls.length}, html ${html.length} 文字`,
          );
        }
        succeeded += 1;
      } catch (e) {
        failed += 1;
        console.error(`  ${row.slug}: 失敗 (${e instanceof Error ? e.message : String(e)})`);
      }
    }

    console.log(`完了: 成功 ${succeeded} 件 / 失敗 ${failed} 件`);
    if (failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    await conn.end();
  }
}

await main();
