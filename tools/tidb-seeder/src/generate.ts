import {
  buildEscapedPool,
  formatDateTime,
  makeRng,
  makeSlug,
  randomPastDate,
  uuid,
} from './fake.js';
import { escapePgText, toRow } from './tsv.js';
import { openBatchedWriter } from './writer.js';

export interface PartitionOptions {
  userIds: string[];
  tagIds: string[];
  seed: number;
  articlesPerUser: number;
  tagsPerArticle: number;
  contentSize: number;
  start: number;
  end: number;
  articlesPath: string;
  articlesTagsPath: string;
  logPrefix: string;
  rowsPerPart: number;
}

const POOL_SIZE = 256;

export async function generatePartition(opts: PartitionOptions): Promise<void> {
  const { userIds, tagIds, seed, articlesPerUser, tagsPerArticle, contentSize, rowsPerPart } = opts;
  const rng = makeRng(seed);
  const tagCount = Math.min(tagsPerArticle, tagIds.length);
  const total = opts.end - opts.start;
  if (total <= 0) return;

  // Precompute escaped strings once. The alternative is escaping every content
  // (~6KB × millions of rows = tens of GB of regex work) which dominates CPU.
  // Contents / titles / descriptions are picked by index at row time; short
  // fields (UUIDs, slugs, ISO dates, status/type literals) are guaranteed to
  // contain no tab / newline / backslash so they're interpolated raw.
  const pool = buildEscapedPool(rng, contentSize, POOL_SIZE, escapePgText);

  // When rowsPerPart > 0 the writer rotates to a new file every N articles so
  // each output stays small enough for TiDB's LOAD DATA (default txn size limit
  // 100MB, 15,000 articles ≈ 90MB). The chunk index is embedded as an underscore
  // suffix in the file name: `<base>.tsv` -> `<base>_0.tsv`, `<base>_1.tsv`, ...
  const rotate = rowsPerPart > 0;
  let chunkIndex = 0;
  let rowsInChunk = 0;
  let articlesOut = openBatchedWriter(chunkedPath(opts.articlesPath, rotate, chunkIndex));
  let tagsOut = openBatchedWriter(chunkedPath(opts.articlesTagsPath, rotate, chunkIndex));

  const chosen = new Set<number>();
  const startedAt = Date.now();
  let done = 0;

  try {
    for (let idx = opts.start; idx < opts.end; idx++) {
      const userIndex = Math.floor(idx / articlesPerUser);
      const userId = userIds[userIndex] as string;
      const articleId = uuid();
      const type = rng() < 0.6 ? 'tech' : 'note';
      const status = rng() < 0.9 ? 'published' : 'draft';
      const publishedAt = status === 'published' ? formatDateTime(randomPastDate(rng, 3)) : '\\N';
      const createdAt = formatDateTime(randomPastDate(rng, 3));
      const slug = makeSlug(rng, idx);

      const titleIdx = Math.floor(rng() * POOL_SIZE);
      const contentIdx = Math.floor(rng() * POOL_SIZE);
      const descIdx = Math.floor(rng() * POOL_SIZE);

      await articlesOut.write(
        `${articleId}\t${pool.titles[titleIdx]}\t${slug}\t${userId}\t${pool.contents[contentIdx]}\t\\N\t${pool.descriptions[descIdx]}\t${status}\t${type}\t${publishedAt}\t${createdAt}\t${createdAt}\n`,
      );

      chosen.clear();
      while (chosen.size < tagCount) {
        chosen.add(Math.floor(rng() * tagIds.length));
      }
      for (const ti of chosen) {
        const tagId = tagIds[ti] as string;
        await tagsOut.write(`${articleId}\t${tagId}\n`);
      }

      rowsInChunk++;
      done++;

      if (rotate && rowsInChunk >= rowsPerPart && done < total) {
        await Promise.all([articlesOut.end(), tagsOut.end()]);
        chunkIndex++;
        rowsInChunk = 0;
        articlesOut = openBatchedWriter(chunkedPath(opts.articlesPath, rotate, chunkIndex));
        tagsOut = openBatchedWriter(chunkedPath(opts.articlesTagsPath, rotate, chunkIndex));
      }

      if (done % 50000 === 0 || done === total) {
        logProgress(opts.logPrefix, done, total, startedAt);
      }
    }
  } finally {
    await Promise.all([articlesOut.end(), tagsOut.end()]);
  }
}

function chunkedPath(basePath: string, rotate: boolean, chunkIndex: number): string {
  if (!rotate) return basePath;
  return basePath.replace(/\.tsv$/, `_${chunkIndex}.tsv`);
}

export interface UserRow {
  id: string;
  name: string;
  email: string;
  createdAt: string;
}

export function buildUsersTsv(users: UserRow[]): string {
  return users.map((u) => toRow([u.id, u.name, u.email, null, u.createdAt, u.createdAt])).join('');
}

export function buildTagsTsv(tagIds: string[], runTag: string): string {
  return tagIds.map((id, i) => toRow([id, `tag-${runTag}-${i}`])).join('');
}

export function makeUsers(
  count: number,
  rng: () => number,
  now: string,
): { users: UserRow[]; runTag: string } {
  const runTag = Math.floor(rng() * 1e6)
    .toString(36)
    .padStart(4, '0');
  const users: UserRow[] = [];
  for (let i = 0; i < count; i++) {
    users.push({
      id: uuid(),
      name: `testuser-${runTag}-${i}`,
      email: `testuser-${runTag}-${i}@example.com`,
      createdAt: now,
    });
  }
  return { users, runTag };
}

export function makeTagIds(count: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) ids.push(uuid());
  return ids;
}

function logProgress(prefix: string, done: number, total: number, startedAt: number): void {
  const pct = ((done / total) * 100).toFixed(1);
  const elapsed = (Date.now() - startedAt) / 1000;
  const rate = done / Math.max(elapsed, 0.001);
  const eta = rate > 0 ? Math.round((total - done) / rate) : 0;
  log(`${prefix}  ${done}/${total} (${pct}%)  ${rate.toFixed(0)} rows/s  eta ${eta}s`);
}

export function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

export function partPaths(
  outDir: string,
  schema: string,
  workerIndex: number,
): { articlesPath: string; articlesTagsPath: string } {
  const suffix = `.part${workerIndex}`;
  return {
    articlesPath: `${outDir}/${schema}.articles${suffix}.tsv`,
    articlesTagsPath: `${outDir}/${schema}.articles_tags${suffix}.tsv`,
  };
}
