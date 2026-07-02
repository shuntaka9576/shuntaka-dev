import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { formatDateTime, makeRng } from './fake.js';
import {
  buildTagsTsv,
  buildUsersTsv,
  generatePartition,
  log,
  makeTagIds,
  makeUsers,
} from './generate.js';

export interface MasterOptions {
  outDir: string;
  sourceSchema: string;
  users: number;
  articlesPerUser: number;
  tags: number;
  tagsPerArticle: number;
  contentSize: number;
  seed: number;
  workers: number;
  noConcat: boolean;
  rowsPerPart: number;
}

interface StateFile {
  userIds: string[];
  tagIds: string[];
  articlesPerUser: number;
  tagsPerArticle: number;
  contentSize: number;
  seed: number;
  sourceSchema: string;
  outDir: string;
  rowsPerPart: number;
}

const STATE_FILE = '_seeder-state.json';

export async function runMaster(opts: MasterOptions): Promise<void> {
  fs.mkdirSync(opts.outDir, { recursive: true });

  const rng = makeRng(opts.seed);
  const now = formatDateTime(new Date());

  const { users, runTag } = makeUsers(opts.users, rng, now);
  const tagIds = makeTagIds(opts.tags);

  const usersPath = path.join(opts.outDir, `${opts.sourceSchema}.users.tsv`);
  const tagsPath = path.join(opts.outDir, `${opts.sourceSchema}.tags.tsv`);
  fs.writeFileSync(usersPath, buildUsersTsv(users));
  fs.writeFileSync(tagsPath, buildTagsTsv(tagIds, runTag));
  log(`users: ${users.length} rows -> ${usersPath}`);
  log(`tags: ${tagIds.length} rows -> ${tagsPath}`);

  const totalArticles = opts.users * opts.articlesPerUser;
  const chunkSize = Math.ceil(totalArticles / opts.workers);
  log(`articles: ${totalArticles} rows, ${opts.workers} worker(s), chunk ${chunkSize}`);

  cleanupParts(opts.outDir, opts.sourceSchema);

  if (opts.workers === 1) {
    // Single-process fast path. Without rotation we write straight to the final
    // .tsv (backward compat and avoids the pointless "cat one 30GB file" step);
    // with rotation we still write via part naming so load.sh's part glob picks
    // the chunks up.
    const rotate = opts.rowsPerPart > 0;
    const articlesBase = rotate
      ? path.join(opts.outDir, `${opts.sourceSchema}.articles.part0.tsv`)
      : path.join(opts.outDir, `${opts.sourceSchema}.articles.tsv`);
    const articlesTagsBase = rotate
      ? path.join(opts.outDir, `${opts.sourceSchema}.articles_tags.part0.tsv`)
      : path.join(opts.outDir, `${opts.sourceSchema}.articles_tags.tsv`);
    await generatePartition({
      userIds: users.map((u) => u.id),
      tagIds,
      seed: opts.seed,
      articlesPerUser: opts.articlesPerUser,
      tagsPerArticle: opts.tagsPerArticle,
      contentSize: opts.contentSize,
      start: 0,
      end: totalArticles,
      articlesPath: articlesBase,
      articlesTagsPath: articlesTagsBase,
      logPrefix: '[worker 0]',
      rowsPerPart: opts.rowsPerPart,
    });
    return;
  }

  const stateFile = path.join(opts.outDir, STATE_FILE);
  const state: StateFile = {
    userIds: users.map((u) => u.id),
    tagIds,
    articlesPerUser: opts.articlesPerUser,
    tagsPerArticle: opts.tagsPerArticle,
    contentSize: opts.contentSize,
    seed: opts.seed,
    sourceSchema: opts.sourceSchema,
    outDir: opts.outDir,
    rowsPerPart: opts.rowsPerPart,
  };
  fs.writeFileSync(stateFile, JSON.stringify(state));

  try {
    await spawnWorkers(opts.workers, stateFile);
  } finally {
    fs.unlinkSync(stateFile);
  }

  if (opts.noConcat) {
    log(
      `parts left as ${opts.sourceSchema}.<table>.part<N>[_<C>].tsv; load.sh will detect and LOAD DATA per part`,
    );
    return;
  }

  await concatParts(opts.outDir, opts.sourceSchema, 'articles');
  await concatParts(opts.outDir, opts.sourceSchema, 'articles_tags');
  log('concat + cleanup done');
}

function cleanupParts(outDir: string, schema: string): void {
  const stalePrefixes = [`${schema}.articles.part`, `${schema}.articles_tags.part`];
  const staleSingles = [`${schema}.articles.tsv`, `${schema}.articles_tags.tsv`];
  for (const f of fs.readdirSync(outDir)) {
    if (stalePrefixes.some((p) => f.startsWith(p)) || staleSingles.includes(f)) {
      fs.unlinkSync(path.join(outDir, f));
    }
  }
}

async function spawnWorkers(workers: number, stateFile: string): Promise<void> {
  // Prefer `bun` as the worker runtime: bun boots in ~50ms with native TS support,
  // whereas the parent (tsx-on-node) pays ~1–2s per fork for `--require preflight`
  // + `--import loader` + node cold start. Fall back to the parent runtime + its
  // exec argv (which carries tsx's loader flags) if `bun` isn't on PATH.
  const script = process.argv[1] as string;
  const bunPath = process.env.BUN_INSTALL ? `${process.env.BUN_INSTALL}/bin/bun` : 'bun';

  const buildCmd = (workerIndex: number): { command: string; args: string[] } => {
    // Must include the `generate` subcommand name so commander dispatches to
    // the correct action; without it commander would print help and exit.
    const workerArgs = [
      'generate',
      '--worker-index',
      String(workerIndex),
      '--workers',
      String(workers),
      '--state-file',
      stateFile,
    ];
    return {
      command: bunPath,
      args: [script, ...workerArgs],
    };
  };

  const children = Array.from({ length: workers }, (_, k) => {
    return new Promise<void>((resolve, reject) => {
      const { command, args } = buildCmd(k);
      const child = spawn(command, args, { stdio: 'inherit' });
      child.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`worker ${k} exited with code ${code}`));
      });
      child.on('error', (err) => {
        reject(new Error(`failed to spawn worker ${k} (${command}): ${err.message}`));
      });
    });
  });

  await Promise.all(children);
}

async function concatParts(outDir: string, schema: string, table: string): Promise<void> {
  const finalPath = path.join(outDir, `${schema}.${table}.tsv`);
  const prefix = `${schema}.${table}.part`;
  const parts = fs
    .readdirSync(outDir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.tsv'))
    .sort(comparePartFile)
    .map((f) => path.join(outDir, f));
  if (parts.length === 0) return;

  await new Promise<void>((resolve, reject) => {
    const outFd = fs.openSync(finalPath, 'w');
    const cat = spawn('cat', parts, { stdio: ['ignore', outFd, 'inherit'] });
    cat.on('exit', (code) => {
      fs.closeSync(outFd);
      if (code === 0) resolve();
      else reject(new Error(`cat exited with code ${code}`));
    });
    cat.on('error', reject);
  });
  for (const p of parts) fs.unlinkSync(p);
  log(`concat: ${table}.tsv <- ${parts.length} parts`);
}

function comparePartFile(a: string, b: string): number {
  const ka = partKey(a);
  const kb = partKey(b);
  if (ka.worker !== kb.worker) return ka.worker - kb.worker;
  return ka.chunk - kb.chunk;
}

function partKey(name: string): { worker: number; chunk: number } {
  const m = name.match(/\.part(\d+)(?:_(\d+))?\.tsv$/);
  if (!m) return { worker: Number.MAX_SAFE_INTEGER, chunk: Number.MAX_SAFE_INTEGER };
  return {
    worker: Number.parseInt(m[1] as string, 10),
    chunk: m[2] !== undefined ? Number.parseInt(m[2], 10) : 0,
  };
}
