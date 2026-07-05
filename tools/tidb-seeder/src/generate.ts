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
  /** article type（tech/note）ごとの付与可能タグ ID。Zipf 重み順（先頭ほど高頻度） */
  tagLeaves: TagLeaves;
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

export interface TagRow {
  id: string;
  name: string;
  parentId: string | null;
}

/** article type → 付与可能タグ（子を持たないタグ）の ID リスト */
export interface TagLeaves {
  tech: string[];
  note: string[];
}

/** Zipf 分布 (s=1) の累積重み。sampleZipfIndex とペアで使う */
function buildZipfCumulative(n: number): Float64Array {
  const cum = new Float64Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += 1 / (i + 1);
    cum[i] = acc;
  }
  return cum;
}

function sampleZipfIndex(cum: Float64Array, r: number): number {
  const target = r * (cum[cum.length - 1] as number);
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((cum[mid] as number) < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const POOL_SIZE = 256;

export async function generatePartition(opts: PartitionOptions): Promise<void> {
  const { userIds, tagLeaves, seed, articlesPerUser, tagsPerArticle, contentSize, rowsPerPart } =
    opts;
  const rng = makeRng(seed);
  const total = opts.end - opts.start;
  if (total <= 0) return;

  // type ごとに Zipf 累積重みを前計算し、記事の type に対応する leaf 群から選ぶ
  const leafSets = {
    tech: { ids: tagLeaves.tech, cum: buildZipfCumulative(tagLeaves.tech.length) },
    note: { ids: tagLeaves.note, cum: buildZipfCumulative(tagLeaves.note.length) },
  } as const;

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

      const leafSet = leafSets[type];
      const tagCount = Math.min(tagsPerArticle, leafSet.ids.length);
      chosen.clear();
      while (chosen.size < tagCount) {
        chosen.add(sampleZipfIndex(leafSet.cum, rng()));
      }
      for (const ti of chosen) {
        const tagId = leafSet.ids[ti] as string;
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

export function buildTagsTsv(tags: TagRow[]): string {
  return tags.map((t) => toRow([t.id, t.name, t.parentId])).join('');
}

/**
 * 本番のタグ構造（root=type 名 / 最大3階層 / leaf のみに記事を紐付け）を模した
 * タグツリーを生成する。
 *
 * - root は tech / misc の2つ（記事 type と対応。note 記事には misc/* を付ける）
 * - 2階層目の約半分は子（3階層目）を持ち、残りは childless leaf（aws と rust の関係を再現）
 * - 付与可能タグ = 子を持たないタグ。呼び出し側で Zipf 分布により選択される
 */
export function makeTagTree(
  count: number,
  runTag: string,
  rng: () => number,
): { tags: TagRow[]; leaves: TagLeaves } {
  const minPerRoot = 4;
  if (count < 2 + minPerRoot * 2) {
    throw new Error(`--tags must be >= ${2 + minPerRoot * 2} for hierarchical generation`);
  }

  const techRoot: TagRow = { id: uuid(), name: 'tech', parentId: null };
  const miscRoot: TagRow = { id: uuid(), name: 'misc', parentId: null };
  const tags: TagRow[] = [techRoot, miscRoot];

  // 残りタグを tech:misc = 7:3、各 root 内で level2:level3 = 4:6 に配分
  const remaining = count - 2;
  const techTotal = Math.max(minPerRoot, Math.round(remaining * 0.7));
  const miscTotal = Math.max(minPerRoot, remaining - techTotal);

  const leaves: TagLeaves = { tech: [], note: [] };
  const buildSubtree = (root: TagRow, total: number, prefix: string, leafIds: string[]) => {
    const level2Count = Math.max(2, Math.round(total * 0.4));
    const level3Count = total - level2Count;
    const level2: TagRow[] = [];
    for (let i = 0; i < level2Count; i++) {
      const t: TagRow = { id: uuid(), name: `${prefix}-c${i}-${runTag}`, parentId: root.id };
      level2.push(t);
      tags.push(t);
    }
    // 前半の level2 だけが子を持つ（後半は childless leaf として付与対象になる）
    const parentPool = level2.slice(0, Math.max(1, Math.floor(level2Count / 2)));
    const hasChildren = new Set<string>();
    for (let i = 0; i < level3Count; i++) {
      const parent = parentPool[i % parentPool.length] as TagRow;
      hasChildren.add(parent.id);
      const t: TagRow = { id: uuid(), name: `${prefix}-l${i}-${runTag}`, parentId: parent.id };
      tags.push(t);
      leafIds.push(t.id);
    }
    for (const t of level2) {
      if (!hasChildren.has(t.id)) leafIds.push(t.id);
    }
  };

  buildSubtree(techRoot, techTotal, 'tech', leaves.tech);
  buildSubtree(miscRoot, miscTotal, 'misc', leaves.note);

  // Zipf の rank をタグ生成順と独立にするためシャッフル（決定的 rng）
  for (const ids of [leaves.tech, leaves.note]) {
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = ids[i] as string;
      ids[i] = ids[j] as string;
      ids[j] = tmp;
    }
  }
  return { tags, leaves };
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
