import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { program } from 'commander';
import { runLoad, type LoadOptions } from './load.js';
import { runMaster, type MasterOptions } from './master.js';
import { runWorker } from './worker.js';

function toInt(name: string, value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`--${name} must be a non-negative integer (got ${value})`);
  }
  return n;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DDL_DIR = path.resolve(HERE, '../../dsql-cli/dsl-tidb/schema');
const DEFAULT_LOAD_DIR = path.resolve(HERE, '../../dsql-cli/dsl-tidb/load');

program
  .name('tidb-seeder')
  .description(
    'Generate fake blog data as PG TEXT-compatible TSV files, and optionally LOAD DATA them into TiDB in parallel.',
  )
  .version('0.1.0');

program
  .command('generate')
  .description('Generate fake TSV files (users / tags / articles / articles_tags)')
  .option('-o, --out-dir <dir>', 'Output directory for TSV files', './out')
  .option(
    '-s, --source-schema <name>',
    'Source schema prefix in TSV filename (default: app; must match load-side --source-schema)',
    'app',
  )
  .option('--users <n>', 'Number of users to create', '3')
  .option('--articles-per-user <n>', 'Articles per user', '10000')
  .option('--tags <n>', 'Number of tags', '100')
  .option('--tags-per-article <n>', 'Tags per article', '3')
  .option('--content-size <bytes>', 'Approximate content bytes per article', '6000')
  .option('--seed <n>', 'PRNG seed (deterministic content across runs)', '42')
  .option(
    '--workers <n>',
    'Parallel worker processes for articles/articles_tags. 1 = single-process.',
    '4',
  )
  .option(
    '--no-concat',
    'Skip concatenating the worker part files. Use with the load step (which auto-detects parts) to skip the cat step.',
  )
  .option(
    '--rows-per-part <n>',
    "Rotate to a new part file every N articles. Each part becomes `<schema>.<table>.part<W>_<C>.tsv`. Needed to keep files under TiDB's LOAD DATA txn-size limit (100MB default): 15000 rows ≈ 90MB. 0 = no rotation.",
    '0',
  )
  .option(
    '--worker-index <k>',
    'Internal: set by master when spawning a worker. Do not set manually.',
  )
  .option(
    '--state-file <path>',
    'Internal: set by master. Path to the shared state JSON. Do not set manually.',
  )
  .action(async (options) => {
    try {
      if (options.workerIndex !== undefined) {
        await runWorker({
          workerIndex: toInt('worker-index', String(options.workerIndex)),
          workers: toInt('workers', String(options.workers)),
          stateFile: String(options.stateFile),
        });
        return;
      }
      const opts: MasterOptions = {
        outDir: String(options.outDir),
        sourceSchema: String(options.sourceSchema),
        users: toInt('users', String(options.users)),
        articlesPerUser: toInt('articles-per-user', String(options.articlesPerUser)),
        tags: toInt('tags', String(options.tags)),
        tagsPerArticle: toInt('tags-per-article', String(options.tagsPerArticle)),
        contentSize: toInt('content-size', String(options.contentSize)),
        seed: toInt('seed', String(options.seed)),
        workers: Math.max(1, toInt('workers', String(options.workers))),
        noConcat: options.concat === false,
        rowsPerPart: toInt('rows-per-part', String(options.rowsPerPart)),
      };
      const startedAt = Date.now();
      await runMaster(opts);
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(`Done in ${elapsed}s.`);
    } catch (err) {
      console.error('Failed:', err);
      process.exit(1);
    }
  });

program
  .command('load')
  .description(
    'LOAD DATA the generated TSV parts into TiDB in parallel (bypasses the sequential mysql-cli approach in load.sh)',
  )
  .option('-H, --host <host>', 'TiDB host', process.env.TIDB_HOST ?? '127.0.0.1')
  .option('-P, --port <port>', 'TiDB port', process.env.TIDB_PORT ?? '4000')
  .option('-u, --user <user>', 'TiDB user', process.env.TIDB_USER ?? 'root')
  .option('-p, --password <password>', 'TiDB password', process.env.TIDB_PASSWORD ?? '')
  .requiredOption('-d, --database <name>', 'Target TiDB database (e.g. blog_test)')
  .option('-t, --tsv-dir <dir>', 'Directory containing TSV files', './out')
  .option('-s, --source-schema <name>', 'Source schema prefix in TSV filename', 'app')
  .option('--parallelism <n>', 'Concurrent LOAD DATA connections', '8')
  .option('--ddl-dir <dir>', 'Directory containing schema/*.sql', DEFAULT_DDL_DIR)
  .option('--load-dir <dir>', 'Directory containing load/*.sql', DEFAULT_LOAD_DIR)
  .action(async (options) => {
    try {
      const opts: LoadOptions = {
        host: String(options.host),
        port: toInt('port', String(options.port)),
        user: String(options.user),
        password: String(options.password ?? ''),
        database: String(options.database),
        tsvDir: String(options.tsvDir),
        sourceSchema: String(options.sourceSchema),
        parallelism: Math.max(1, toInt('parallelism', String(options.parallelism))),
        ddlDir: String(options.ddlDir),
        loadDir: String(options.loadDir),
      };
      const startedAt = Date.now();
      await runLoad(opts);
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(`Done in ${elapsed}s.`);
    } catch (err) {
      console.error('Failed:', err);
      process.exit(1);
    }
  });

program.parse();
