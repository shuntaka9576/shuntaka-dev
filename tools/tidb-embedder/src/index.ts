import { program } from 'commander';
import mysql from 'mysql2/promise';

const EXPECTED_DIMENSION = 2048;

interface ArticleRow extends mysql.RowDataPacket {
  article_id: string;
  slug: string;
  content: string;
}

interface EmbedResponse {
  vector: number[];
  dim: number;
}

function embeddingEndpoint(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`--embed-endpoint が不正な URL: ${baseUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('--embed-endpoint は http または https URL を指定すること');
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/embed`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function positiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} は正の整数で指定すること: ${value}`);
  }
  return parsed;
}

function parseEmbedResponse(payload: unknown): EmbedResponse {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('embedding API のレスポンスが object ではない');
  }

  const { vector, dim } = payload as { vector?: unknown; dim?: unknown };
  if (
    !Array.isArray(vector) ||
    !vector.every((value) => typeof value === 'number' && Number.isFinite(value))
  ) {
    throw new Error('embedding API の vector が有限数の配列ではない');
  }
  if (!Number.isSafeInteger(dim) || dim !== vector.length) {
    throw new Error(
      `embedding API の dim と vector 長が一致しない: dim=${String(dim)}, length=${vector.length}`,
    );
  }
  if (vector.length !== EXPECTED_DIMENSION) {
    throw new Error(
      `embedding の次元数が schema と一致しない: expected=${EXPECTED_DIMENSION}, actual=${vector.length}`,
    );
  }

  return { vector, dim: vector.length };
}

async function embedDocument(
  endpoint: string,
  text: string,
  timeoutMs: number,
): Promise<EmbedResponse> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, mode: 'document' }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(
      `embedding API への接続に失敗: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!response.ok) {
    const body = (await response.text()).slice(0, 200);
    throw new Error(`embedding API が HTTP ${response.status} を返した${body ? `: ${body}` : ''}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(
      `embedding API の JSON を解析できない: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseEmbedResponse(payload);
}

async function main(): Promise<void> {
  program
    .name('tidb-embedder')
    .description(
      'PLaMo Embedding Service で articles.embedding を生成する。updated_at は変更しない',
    )
    .requiredOption(
      '--endpoint <url>',
      'TiDB 接続 URL (例: mysql://root@tidb.<TAILNET>:4000/blog_dev)',
    )
    .requiredOption(
      '--embed-endpoint <url>',
      'PLaMo Embedding Service URL (例: http://localhost:8080)',
    )
    .option('--all', 'embedding が埋まっている記事も再生成する', false)
    .option('--slug <slug>', '指定 slug の記事だけ処理する')
    .option('--dry-run', 'UPDATE せず、対象記事と生成した embedding の次元数を表示する', false)
    .option('--concurrency <n>', 'embedding API への同時リクエスト数', '1')
    .option('--timeout <ms>', '記事1件あたりの embedding API timeout (ms)', '120000')
    .parse();

  const opts = program.opts<{
    endpoint: string;
    embedEndpoint: string;
    all: boolean;
    slug?: string;
    dryRun: boolean;
    concurrency: string;
    timeout: string;
  }>();
  const concurrency = positiveInteger(opts.concurrency, '--concurrency');
  const timeoutMs = positiveInteger(opts.timeout, '--timeout');
  const embedEndpoint = embeddingEndpoint(opts.embedEndpoint);
  const conn = await mysql.createConnection(opts.endpoint);

  try {
    const conditions: string[] = [];
    const params: string[] = [];
    if (!opts.all) {
      conditions.push('embedding IS NULL');
    }
    if (opts.slug) {
      conditions.push('slug = ?');
      params.push(opts.slug);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const [rows] = await conn.execute<ArticleRow[]>(
      `SELECT article_id, slug, content FROM articles ${where} ORDER BY article_id`,
      params,
    );

    console.log(`対象記事: ${rows.length} 件${opts.dryRun ? ' (dry-run)' : ''}`);
    if (opts.slug && rows.length === 0) {
      throw new Error(`対象記事が見つからない: slug=${opts.slug}`);
    }

    let succeeded = 0;
    let failed = 0;
    let updated = 0;

    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (nextIndex < rows.length) {
        const index = nextIndex;
        nextIndex += 1;
        const row = rows[index];

        try {
          const { vector, dim } = await embedDocument(embedEndpoint, row.content, timeoutMs);
          const progress = `[${index + 1}/${rows.length}] ${row.slug}: dim ${dim}`;

          if (opts.dryRun) {
            console.log(`  [dry-run] ${progress}`);
          } else {
            const updateSql = opts.all
              ? 'UPDATE articles SET embedding = ? WHERE article_id = ?'
              : 'UPDATE articles SET embedding = ? WHERE article_id = ? AND embedding IS NULL';
            const [result] = await conn.execute<mysql.ResultSetHeader>(updateSql, [
              JSON.stringify(vector),
              row.article_id,
            ]);
            updated += result.affectedRows;
            console.log(
              `  ${progress}${result.affectedRows === 0 ? ' (更新済みのためスキップ)' : ''}`,
            );
          }
          succeeded += 1;
        } catch (error) {
          failed += 1;
          console.error(
            `  [${index + 1}/${rows.length}] ${row.slug}: 失敗 (${error instanceof Error ? error.message : String(error)})`,
          );
        }
      }
    };

    const workerCount = Math.min(concurrency, rows.length);
    await Promise.all(Array.from({ length: workerCount }, worker));

    console.log(
      `完了: 成功 ${succeeded} 件 / 失敗 ${failed} 件${opts.dryRun ? '' : ` / 更新 ${updated} 件`}`,
    );
    if (failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    await conn.end();
  }
}

try {
  await main();
} catch (error) {
  console.error(`エラー: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
