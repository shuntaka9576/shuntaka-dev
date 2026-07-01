import * as fs from 'node:fs';
import { generatePartition, log, partPaths } from './generate.js';

export interface WorkerOptions {
  workerIndex: number;
  workers: number;
  stateFile: string;
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

export async function runWorker(opts: WorkerOptions): Promise<void> {
  const state = JSON.parse(fs.readFileSync(opts.stateFile, 'utf-8')) as StateFile;
  const totalArticles = state.userIds.length * state.articlesPerUser;
  const chunkSize = Math.ceil(totalArticles / opts.workers);
  const start = opts.workerIndex * chunkSize;
  const end = Math.min(start + chunkSize, totalArticles);

  const { articlesPath, articlesTagsPath } = partPaths(
    state.outDir,
    state.sourceSchema,
    opts.workerIndex,
  );

  log(`[worker ${opts.workerIndex}] range ${start}..${end} (${end - start} rows)`);
  await generatePartition({
    userIds: state.userIds,
    tagIds: state.tagIds,
    seed: state.seed + opts.workerIndex,
    articlesPerUser: state.articlesPerUser,
    tagsPerArticle: state.tagsPerArticle,
    contentSize: state.contentSize,
    start,
    end,
    articlesPath,
    articlesTagsPath,
    logPrefix: `[worker ${opts.workerIndex}]`,
    rowsPerPart: state.rowsPerPart,
  });
}
