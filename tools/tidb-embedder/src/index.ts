import { createHash } from 'node:crypto';

import { program } from 'commander';
import mysql from 'mysql2/promise';

const EXPECTED_DIMENSION = 2048;
const EXPECTED_CHUNKING_VERSION = 'plamo-markdown-1024-v1';

interface ArticleRow extends mysql.RowDataPacket {
  article_id: string;
  slug: string;
  title: string;
  description: string;
  content: string;
  existing_chunk_count: number;
  existing_hash_count: number;
  existing_source_hash: string | null;
}

interface CountRow extends mysql.RowDataPacket {
  count: number;
}

interface EmbedResponse {
  vector: number[];
  dim: number;
}

interface DocumentChunk {
  index: number;
  heading: string | null;
  content: string;
  embeddingText: string;
  tokenCount: number;
}

interface ChunksResponse {
  version: string;
  maxTokens: number;
  overlapTokens: number;
  chunks: DocumentChunk[];
}

interface ServiceEndpoints {
  embed: string;
  chunks: string;
}

function serviceEndpoints(baseUrl: string): ServiceEndpoints {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`--embed-endpoint が不正な URL: ${baseUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('--embed-endpoint は http または https URL を指定すること');
  }

  const basePath = url.pathname.replace(/\/+$/, '');
  const endpoint = (path: string): string => {
    const result = new URL(url);
    result.pathname = `${basePath}/${path}`;
    result.search = '';
    result.hash = '';
    return result.toString();
  };
  return { embed: endpoint('embed'), chunks: endpoint('chunks') };
}

function positiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} は正の整数で指定すること: ${value}`);
  }
  return parsed;
}

function nonNegativeInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${option} は0以上の整数で指定すること: ${value}`);
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

function parseChunksResponse(payload: unknown): ChunksResponse {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('chunks API のレスポンスが object ではない');
  }

  const raw = payload as {
    version?: unknown;
    max_tokens?: unknown;
    overlap_tokens?: unknown;
    chunks?: unknown;
  };
  if (raw.version !== EXPECTED_CHUNKING_VERSION) {
    throw new Error(
      `chunks API のversionが不一致: expected=${EXPECTED_CHUNKING_VERSION}, actual=${String(raw.version)}`,
    );
  }
  if (!Number.isSafeInteger(raw.max_tokens) || !Number.isSafeInteger(raw.overlap_tokens)) {
    throw new Error('chunks API のtoken設定が整数ではない');
  }
  if (!Array.isArray(raw.chunks) || raw.chunks.length === 0) {
    throw new Error('chunks API のchunksが空または配列ではない');
  }

  const chunks = raw.chunks.map((value, index): DocumentChunk => {
    if (typeof value !== 'object' || value === null) {
      throw new Error(`chunks API のchunks[${index}]がobjectではない`);
    }
    const chunk = value as {
      index?: unknown;
      heading?: unknown;
      content?: unknown;
      embedding_text?: unknown;
      token_count?: unknown;
    };
    if (chunk.index !== index) {
      throw new Error(
        `chunks API のindexが連番ではない: expected=${index}, actual=${String(chunk.index)}`,
      );
    }
    if (chunk.heading !== null && typeof chunk.heading !== 'string') {
      throw new Error(`chunks API のchunks[${index}].headingが文字列またはnullではない`);
    }
    if (typeof chunk.content !== 'string' || typeof chunk.embedding_text !== 'string') {
      throw new Error(`chunks API のchunks[${index}]のtextが文字列ではない`);
    }
    if (!Number.isSafeInteger(chunk.token_count) || (chunk.token_count as number) <= 0) {
      throw new Error(`chunks API のchunks[${index}].token_countが正の整数ではない`);
    }
    return {
      index,
      heading: chunk.heading,
      content: chunk.content,
      embeddingText: chunk.embedding_text,
      tokenCount: chunk.token_count as number,
    };
  });

  return {
    version: raw.version,
    maxTokens: raw.max_tokens as number,
    overlapTokens: raw.overlap_tokens as number,
    chunks,
  };
}

async function postJson(endpoint: string, body: unknown, timeoutMs: number): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      // Kubernetes Service のbackend選択はTCP connection単位。connectionを再利用せず、
      // backfill中のリクエストを複数のPLaMO Podへ分散させる。
      headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(
      `PLaMO Service への接続に失敗: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!response.ok) {
    const responseBody = (await response.text()).slice(0, 500);
    throw new Error(
      `PLaMO Service が HTTP ${response.status} を返した${responseBody ? `: ${responseBody}` : ''}`,
    );
  }

  try {
    return await response.json();
  } catch (error) {
    throw new Error(
      `PLaMO Service の JSON を解析できない: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function embedDocument(
  endpoint: string,
  text: string,
  timeoutMs: number,
): Promise<EmbedResponse> {
  return parseEmbedResponse(await postJson(endpoint, { text, mode: 'document' }, timeoutMs));
}

async function chunkArticle(
  endpoint: string,
  row: ArticleRow,
  maxTokens: number,
  overlapTokens: number,
  timeoutMs: number,
): Promise<ChunksResponse> {
  const result = parseChunksResponse(
    await postJson(
      endpoint,
      {
        title: row.title,
        description: row.description,
        content: row.content,
        max_tokens: maxTokens,
        overlap_tokens: overlapTokens,
      },
      timeoutMs,
    ),
  );
  if (result.maxTokens !== maxTokens || result.overlapTokens !== overlapTokens) {
    throw new Error(
      `chunks API のtoken設定がrequestと不一致: max=${result.maxTokens}, overlap=${result.overlapTokens}`,
    );
  }
  if (result.chunks.some((chunk) => chunk.tokenCount > maxTokens)) {
    throw new Error(`chunks API が上限 ${maxTokens} tokensを超えるchunkを返した`);
  }
  return result;
}

function sourceHash(row: ArticleRow, maxTokens: number, overlapTokens: number): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: EXPECTED_CHUNKING_VERSION,
        maxTokens,
        overlapTokens,
        title: row.title,
        description: row.description,
        content: row.content,
      }),
    )
    .digest('hex');
}

async function replaceChunks(
  pool: mysql.Pool,
  row: ArticleRow,
  chunks: Array<DocumentChunk & { vector: number[] }>,
  hash: string,
): Promise<void> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute('DELETE FROM article_embedding_chunks WHERE article_id = ?', [
      row.article_id,
    ]);
    for (const chunk of chunks) {
      await conn.execute(
        `INSERT INTO article_embedding_chunks
           (article_id, chunk_index, heading, content, token_count,
            chunking_version, source_hash, embedding)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.article_id,
          chunk.index,
          chunk.heading,
          chunk.content,
          chunk.tokenCount,
          EXPECTED_CHUNKING_VERSION,
          hash,
          JSON.stringify(chunk.vector),
        ],
      );
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function main(): Promise<void> {
  program
    .name('tidb-embedder')
    .description('記事をPLaMO tokenizerでchunk化し、article_embedding_chunksを記事単位で差し替える')
    .requiredOption(
      '--endpoint <url>',
      'TiDB 接続 URL (例: mysql://root@tidb.<TAILNET>:4000/blog_dev)',
    )
    .requiredOption(
      '--embed-endpoint <url>',
      'PLaMO Embedding Service URL (例: http://localhost:8080)',
    )
    .option('--all', 'source hashが一致する記事も再生成する', false)
    .option('--slug <slug>', '指定slugの記事だけ処理する')
    .option(
      '--dry-run',
      'chunkを生成して件数とtoken数を表示する。embeddingとDB更新は行わない',
      false,
    )
    .option('--concurrency <n>', 'embedding APIへの同時リクエスト数', '1')
    .option('--timeout <ms>', 'PLaMO API 1リクエストあたりのtimeout (ms)', '120000')
    .option('--max-tokens <n>', '1 chunkの最大token数', '1024')
    .option('--overlap-tokens <n>', '分割chunk間で重複させるtoken数', '128')
    .parse();

  const opts = program.opts<{
    endpoint: string;
    embedEndpoint: string;
    all: boolean;
    slug?: string;
    dryRun: boolean;
    concurrency: string;
    timeout: string;
    maxTokens: string;
    overlapTokens: string;
  }>();
  const concurrency = positiveInteger(opts.concurrency, '--concurrency');
  const timeoutMs = positiveInteger(opts.timeout, '--timeout');
  const maxTokens = positiveInteger(opts.maxTokens, '--max-tokens');
  const overlapTokens = nonNegativeInteger(opts.overlapTokens, '--overlap-tokens');
  if (maxTokens < 64 || maxTokens > 4096) {
    throw new Error('--max-tokens は64以上、PLaMOの最大context長4096以下にすること');
  }
  if (overlapTokens >= maxTokens) {
    throw new Error('--overlap-tokens は --max-tokens より小さくすること');
  }

  const endpoints = serviceEndpoints(opts.embedEndpoint);
  const pool = mysql.createPool(opts.endpoint);

  try {
    const where = opts.slug ? 'WHERE a.slug = ?' : '';
    const params = opts.slug ? [opts.slug] : [];
    const [rows] = await pool.execute<ArticleRow[]>(
      `SELECT a.article_id, a.slug, a.title, a.description, a.content,
              COALESCE(c.chunk_count, 0) AS existing_chunk_count,
              COALESCE(c.hash_count, 0) AS existing_hash_count,
              c.source_hash AS existing_source_hash
         FROM articles AS a
         LEFT JOIN (
           SELECT article_id, COUNT(*) AS chunk_count,
                  COUNT(DISTINCT source_hash) AS hash_count,
                  MIN(source_hash) AS source_hash
             FROM article_embedding_chunks
            GROUP BY article_id
         ) AS c ON c.article_id = a.article_id
         ${where}
        ORDER BY a.article_id`,
      params,
    );

    if (opts.slug && rows.length === 0) {
      throw new Error(`対象記事が見つからない: slug=${opts.slug}`);
    }

    const targets = rows.filter((row) => {
      if (opts.all) return true;
      const hash = sourceHash(row, maxTokens, overlapTokens);
      return (
        Number(row.existing_chunk_count) === 0 ||
        Number(row.existing_hash_count) !== 1 ||
        row.existing_source_hash !== hash
      );
    });

    console.log(
      `対象記事: ${targets.length} / ${rows.length} 件${opts.dryRun ? ' (dry-run)' : ''}`,
    );

    if (!opts.slug) {
      const [orphanRows] = await pool.execute<CountRow[]>(
        `SELECT COUNT(*) AS count
           FROM article_embedding_chunks AS c
           LEFT JOIN articles AS a ON a.article_id = c.article_id
          WHERE a.article_id IS NULL`,
      );
      const orphanCount = Number(orphanRows[0]?.count ?? 0);
      if (orphanCount > 0) {
        if (opts.dryRun) {
          console.log(`孤立chunk: ${orphanCount} 件 (dry-runのため削除しない)`);
        } else {
          const [result] = await pool.execute<mysql.ResultSetHeader>(
            `DELETE c
               FROM article_embedding_chunks AS c
               LEFT JOIN articles AS a ON a.article_id = c.article_id
              WHERE a.article_id IS NULL`,
          );
          console.log(`孤立chunk削除: ${result.affectedRows} 件`);
        }
      }
    }
    if (targets.length === 0) return;

    let succeeded = 0;
    let failed = 0;
    let replaced = 0;
    let generatedChunks = 0;
    let nextIndex = 0;

    const worker = async (): Promise<void> => {
      while (nextIndex < targets.length) {
        const index = nextIndex;
        nextIndex += 1;
        const row = targets[index];

        try {
          const result = await chunkArticle(
            endpoints.chunks,
            row,
            maxTokens,
            overlapTokens,
            timeoutMs,
          );
          const totalTokens = result.chunks.reduce((sum, chunk) => sum + chunk.tokenCount, 0);
          generatedChunks += result.chunks.length;

          if (opts.dryRun) {
            console.log(
              `  [${index + 1}/${targets.length}] ${row.slug}: ${result.chunks.length} chunks / ${totalTokens} tokens`,
            );
          } else {
            const embedded: Array<DocumentChunk & { vector: number[] }> = [];
            for (const chunk of result.chunks) {
              const { vector } = await embedDocument(
                endpoints.embed,
                chunk.embeddingText,
                timeoutMs,
              );
              embedded.push({ ...chunk, vector });
            }
            await replaceChunks(pool, row, embedded, sourceHash(row, maxTokens, overlapTokens));
            replaced += 1;
            console.log(
              `  [${index + 1}/${targets.length}] ${row.slug}: ${result.chunks.length} chunks / ${totalTokens} tokens`,
            );
          }
          succeeded += 1;
        } catch (error) {
          failed += 1;
          console.error(
            `  [${index + 1}/${targets.length}] ${row.slug}: 失敗 (${error instanceof Error ? error.message : String(error)})`,
          );
        }
      }
    };

    const workerCount = Math.min(concurrency, targets.length);
    await Promise.all(Array.from({ length: workerCount }, worker));

    console.log(
      `完了: 成功 ${succeeded} 件 / 失敗 ${failed} 件 / 生成 ${generatedChunks} chunks${opts.dryRun ? '' : ` / 差し替え ${replaced} 件`}`,
    );
    if (failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

try {
  await main();
} catch (error) {
  console.error(`エラー: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
