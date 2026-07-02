import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface LoadOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  tsvDir: string;
  sourceSchema: string;
  parallelism: number;
  ddlDir: string;
  loadDir: string;
}

const TABLES = ['users', 'tags', 'articles', 'articles_tags'] as const;
type Table = (typeof TABLES)[number];

export async function runLoad(opts: LoadOptions): Promise<void> {
  log(`==> Applying DDL to \`${opts.database}\` on ${opts.host}:${opts.port}`);
  await applyDdl(opts);

  log(`==> LOAD DATA (TSV dir: ${opts.tsvDir}, parallelism: ${opts.parallelism})`);
  const overallStart = Date.now();
  for (const table of TABLES) {
    await loadTable(opts, table);
  }
  log(`load complete in ${elapsedText(overallStart)}`);

  log('==> Row count verification');
  for (const table of TABLES) {
    const count = await countRows(opts, table);
    log(`  ${opts.database}.${table}: ${count}`);
  }
}

async function applyDdl(opts: LoadOptions): Promise<void> {
  const files = fs
    .readdirSync(opts.ddlDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const f of files) {
    log(`  apply ${f}`);
    const raw = fs.readFileSync(path.join(opts.ddlDir, f), 'utf-8');
    const sql = substitute(raw, { schema: opts.database });
    await runMysqlPiped(opts, sql);
  }
}

async function loadTable(opts: LoadOptions, table: Table): Promise<void> {
  const parts = enumerateParts(opts.tsvDir, opts.sourceSchema, table);
  if (parts.length === 0) {
    log(`  [SKIP] ${table}: no TSV files found`);
    return;
  }

  const templatePath = findLoadTemplate(opts.loadDir, table);
  const template = fs.readFileSync(templatePath, 'utf-8');
  const parallelism = Math.min(opts.parallelism, parts.length);

  const totalBytes = parts.reduce((acc, p) => acc + safeStatSize(p), 0);
  log(
    `  ${table}: ${parts.length} part(s), total ${bytesText(totalBytes)}, spawning ${parallelism} mysql workers`,
  );
  const startedAt = Date.now();
  const total = parts.length;
  let done = 0;
  let idx = 0;
  let bytesDone = 0;
  const active: boolean[] = Array.from({ length: parallelism }, () => false);

  const workers = Array.from({ length: parallelism }, async (_, workerIdx) => {
    let handled = 0;
    log(`    [worker ${workerIdx}] started`);
    for (;;) {
      const myIdx = idx;
      idx++;
      if (myIdx >= parts.length) break;
      const part = parts[myIdx] as string;
      const partSize = safeStatSize(part);
      active[workerIdx] = true;
      const partStart = Date.now();
      const sql = substitute(template, { schema: opts.database, tsv: part });
      await runMysqlPiped(opts, sql);
      active[workerIdx] = false;
      done++;
      handled++;
      bytesDone += partSize;
      const partSec = ((Date.now() - partStart) / 1000).toFixed(2);
      // Per-part line so parallelism is visible (different worker ids will
      // interleave, e.g. `[worker 3] parts/00_012.tsv done in 3.14s`).
      log(
        `    [worker ${workerIdx}] ${path.basename(part)} loaded in ${partSec}s  (${table}: ${done}/${total})`,
      );
      if (done % 5 === 0 || done === total) {
        const elapsed = (Date.now() - startedAt) / 1000;
        const rate = done / Math.max(elapsed, 0.001);
        const eta = rate > 0 ? Math.round((total - done) / rate) : 0;
        const throughput = bytesDone / 1024 / 1024 / Math.max(elapsed, 0.001);
        const activeCount = active.filter(Boolean).length;
        log(
          `    ${table} progress: ${done}/${total} (${rate.toFixed(1)} parts/s, ${throughput.toFixed(1)} MB/s, ${activeCount} active, eta ${eta}s)`,
        );
      }
    }
    log(`    [worker ${workerIdx}] done (${handled} parts)`);
  });
  await Promise.all(workers);
  log(`  ${table}: ${total} parts loaded in ${elapsedText(startedAt)}`);
}

function runMysqlPiped(opts: LoadOptions, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      '-h',
      opts.host,
      '-P',
      String(opts.port),
      '-u',
      opts.user,
      '--default-character-set=utf8mb4',
      '--local-infile=1',
    ];
    const env: NodeJS.ProcessEnv = opts.password
      ? { ...process.env, MYSQL_PWD: opts.password }
      : { ...process.env };
    // stdout ignored (mysql silent-on-success); stderr piped so we can bundle
    // it into the error message on failure.
    const child = spawn('mysql', args, { stdio: ['pipe', 'ignore', 'pipe'], env });
    const errChunks: Buffer[] = [];
    if (child.stderr) child.stderr.on('data', (c: Buffer) => errChunks.push(c));
    child.on('error', (err) => reject(new Error(`spawn mysql failed: ${err.message}`)));
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const stderr = Buffer.concat(errChunks).toString('utf-8').trim();
      reject(
        new Error(
          `mysql exited with code ${code} signal ${signal ?? 'none'}${stderr ? `\n${stderr}` : ''}`,
        ),
      );
    });
    if (child.stdin) {
      child.stdin.write(sql);
      child.stdin.end();
    } else {
      reject(new Error('mysql child stdin unavailable'));
    }
  });
}

function countRows(opts: LoadOptions, table: Table): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      '-h',
      opts.host,
      '-P',
      String(opts.port),
      '-u',
      opts.user,
      '--default-character-set=utf8mb4',
      '-N',
      '-B',
      '-e',
      `SELECT COUNT(*) FROM \`${opts.database}\`.\`${table}\``,
    ];
    const env: NodeJS.ProcessEnv = opts.password
      ? { ...process.env, MYSQL_PWD: opts.password }
      : { ...process.env };
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    const child = spawn('mysql', args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    if (child.stdout) child.stdout.on('data', (c: Buffer) => chunks.push(c));
    if (child.stderr) child.stderr.on('data', (c: Buffer) => errChunks.push(c));
    child.on('error', (err) => reject(new Error(`spawn mysql failed: ${err.message}`)));
    child.on('exit', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks).toString('utf-8').trim());
        return;
      }
      const stderr = Buffer.concat(errChunks).toString('utf-8').trim();
      reject(new Error(`mysql count exited with code ${code}${stderr ? `\n${stderr}` : ''}`));
    });
  });
}

function safeStatSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function bytesText(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

function elapsedText(startMs: number): string {
  const s = (Date.now() - startMs) / 1000;
  if (s >= 60) {
    const m = Math.floor(s / 60);
    const rem = (s - m * 60).toFixed(1);
    return `${m}m${rem}s`;
  }
  return `${s.toFixed(1)}s`;
}

function enumerateParts(tsvDir: string, sourceSchema: string, table: Table): string[] {
  const files = fs.readdirSync(tsvDir);
  const partPrefix = `${sourceSchema}.${table}.part`;
  const parts = files
    .filter((f) => f.startsWith(partPrefix) && f.endsWith('.tsv'))
    .sort(comparePartFile);
  if (parts.length > 0) return parts.map((f) => path.join(tsvDir, f));
  const single = path.join(tsvDir, `${sourceSchema}.${table}.tsv`);
  if (fs.existsSync(single)) return [single];
  return [];
}

function findLoadTemplate(loadDir: string, table: Table): string {
  const files = fs.readdirSync(loadDir).filter((f) => f.endsWith('.sql'));
  const match = files.find((f) => f.replace(/^\d+_/, '').replace(/\.sql$/, '') === table);
  if (!match) throw new Error(`No load template found for table ${table} in ${loadDir}`);
  return path.join(loadDir, match);
}

function substitute(sql: string, vars: { schema: string; tsv?: string }): string {
  let out = sql.replace(/\$\{SCHEMA\}/g, vars.schema);
  if (vars.tsv !== undefined) {
    out = out.replace(/\$\{TSV\}/g, vars.tsv);
  }
  return out;
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

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}
