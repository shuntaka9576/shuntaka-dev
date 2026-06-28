import * as fs from 'node:fs';
import * as path from 'node:path';
import { DsqlSigner } from '@aws-sdk/dsql-signer';
import { program } from 'commander';
import pg from 'pg';
import { convertJsonlToSql } from './convert.js';
import { exportTables } from './export.js';

const { Client } = pg;

function isPostgresUrl(endpoint: string): boolean {
  return endpoint.startsWith('postgresql://') || endpoint.startsWith('postgres://');
}

async function connectDsql(endpoint: string): Promise<pg.Client> {
  const signer = new DsqlSigner({
    hostname: endpoint,
  });

  const token = await signer.getDbConnectAdminAuthToken();

  const client = new Client({
    host: endpoint,
    port: 5432,
    database: 'postgres',
    user: 'admin',
    password: token,
    ssl: true,
  });

  await client.connect();
  return client;
}

async function connectPostgres(connectionString: string): Promise<pg.Client> {
  const client = new Client({
    connectionString,
  });

  await client.connect();
  return client;
}

async function connect(endpoint: string): Promise<pg.Client> {
  if (isPostgresUrl(endpoint)) {
    return connectPostgres(endpoint);
  }
  return connectDsql(endpoint);
}

function getSqlFiles(sqlDir: string): string[] {
  const files = fs
    .readdirSync(sqlDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  return files.map((file) => path.join(sqlDir, file));
}

async function runMigrations(endpoint: string, sqlDir: string): Promise<void> {
  const mode = isPostgresUrl(endpoint) ? 'PostgreSQL' : 'DSQL';
  console.log(`Connecting to ${mode}: ${endpoint}`);

  const client = await connect(endpoint);
  console.log('Connected successfully');

  try {
    const sqlFiles = getSqlFiles(sqlDir);

    if (sqlFiles.length === 0) {
      console.log(`No SQL files found in ${sqlDir}`);
      return;
    }

    console.log(`Found ${sqlFiles.length} SQL files`);

    for (const filePath of sqlFiles) {
      const fileName = path.basename(filePath);
      console.log(`Executing: ${fileName}`);

      const sql = fs.readFileSync(filePath, 'utf-8');
      await client.query(sql);

      console.log(`  Done: ${fileName}`);
    }

    console.log('All migrations completed successfully');
  } finally {
    await client.end();
  }
}

async function dropSchema(endpoint: string): Promise<void> {
  const mode = isPostgresUrl(endpoint) ? 'PostgreSQL' : 'DSQL';
  console.log(`Connecting to ${mode}: ${endpoint}`);

  const client = await connect(endpoint);
  console.log('Connected successfully');

  try {
    console.log('Dropping schema app...');
    await client.query('DROP SCHEMA IF EXISTS app CASCADE');
    console.log('Schema dropped successfully');
  } finally {
    await client.end();
  }
}

program.name('dsql-cli').description('DSQL migration tool').version('0.1.0');

program
  .command('migrate')
  .description('Run migrations')
  .option(
    '-e, --endpoint <endpoint>',
    'DSQL endpoint or PostgreSQL URL (postgresql://...)',
    process.env.DSQL_CLUSTER_ENDPOINT,
  )
  .option('-s, --sql-dir <dir>', 'Path to SQL files directory', 'dsl')
  .action(async (options) => {
    const { endpoint, sqlDir } = options;

    if (!endpoint) {
      console.error(
        'Error: endpoint is required. Use --endpoint or set DSQL_CLUSTER_ENDPOINT env var',
      );
      process.exit(1);
    }

    try {
      await runMigrations(endpoint, sqlDir);
    } catch (error) {
      console.error('Migration failed:', error);
      process.exit(1);
    }
  });

program
  .command('drop')
  .description('Drop app schema')
  .option(
    '-e, --endpoint <endpoint>',
    'DSQL endpoint or PostgreSQL URL (postgresql://...)',
    process.env.DSQL_CLUSTER_ENDPOINT,
  )
  .action(async (options) => {
    const { endpoint } = options;

    if (!endpoint) {
      console.error(
        'Error: endpoint is required. Use --endpoint or set DSQL_CLUSTER_ENDPOINT env var',
      );
      process.exit(1);
    }

    try {
      await dropSchema(endpoint);
    } catch (error) {
      console.error('Drop failed:', error);
      process.exit(1);
    }
  });

program
  .command('export')
  .description('Export tables to PostgreSQL TEXT-format TSV (for TiDB LOAD DATA)')
  .option(
    '-e, --endpoint <endpoint>',
    'DSQL endpoint or PostgreSQL URL (postgresql://...)',
    process.env.DSQL_CLUSTER_ENDPOINT,
  )
  .option('-o, --out-dir <dir>', 'Output directory for TSV files', 'backup')
  .option('-s, --schema <name>', 'Source schema name', 'app')
  .option(
    '-t, --tables <list>',
    'Comma-separated table list (load order)',
    'users,tags,articles,articles_tags',
  )
  .option('--page-size <n>', 'Rows per page (keyset pagination)', '1000')
  .action(async (options) => {
    const { endpoint, outDir, schema, tables, pageSize } = options;

    if (!endpoint) {
      console.error(
        'Error: endpoint is required. Use --endpoint or set DSQL_CLUSTER_ENDPOINT env var',
      );
      process.exit(1);
    }

    const tableList = String(tables)
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const pageSizeNum = Number.parseInt(String(pageSize), 10);
    if (!Number.isInteger(pageSizeNum) || pageSizeNum <= 0) {
      console.error(`Error: --page-size must be a positive integer (got ${pageSize})`);
      process.exit(1);
    }

    const mode = isPostgresUrl(endpoint) ? 'PostgreSQL' : 'DSQL';
    console.log(`Connecting to ${mode}: ${endpoint}`);
    const client = await connect(endpoint);
    console.log('Connected successfully');
    console.log(`Exporting ${tableList.length} tables from schema "${schema}" -> ${outDir}/`);

    try {
      await exportTables({
        client,
        schema,
        tables: tableList,
        outDir,
        pageSize: pageSizeNum,
      });
      console.log('Export completed successfully');
    } catch (error) {
      console.error('Export failed:', error);
      process.exit(1);
    } finally {
      await client.end();
    }
  });

program
  .command('convert')
  .description('Convert DynamoDB JSONL to SQL INSERT statements')
  .requiredOption('-i, --input <path>', 'Input JSONL file path')
  .option('-o, --output <path>', 'Output SQL file path', 'dsl/99_seed_data.sql')
  .action(async (options) => {
    const { input, output } = options;

    if (!fs.existsSync(input)) {
      console.error(`Error: Input file not found: ${input}`);
      process.exit(1);
    }

    try {
      await convertJsonlToSql(input, output);
    } catch (error) {
      console.error('Conversion failed:', error);
      process.exit(1);
    }
  });

program.parse();
