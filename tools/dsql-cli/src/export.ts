import * as fs from 'node:fs';
import * as path from 'node:path';
import type pg from 'pg';

const NULL_TOKEN = '\\N';
const FIELD_SEP = '\t';
const ROW_SEP = '\n';

function escapePgText(value: string | null | undefined): string {
  if (value === null || value === undefined) return NULL_TOKEN;
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '\\') out += '\\\\';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else out += ch;
  }
  return out;
}

type ColumnMeta = { name: string; dataType: string };

async function fetchColumns(
  client: pg.Client,
  schema: string,
  table: string,
): Promise<ColumnMeta[]> {
  const { rows } = await client.query<{ column_name: string; data_type: string }>(
    `SELECT column_name, data_type
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2
     ORDER BY ordinal_position`,
    [schema, table],
  );
  if (rows.length === 0) {
    throw new Error(`No columns found for ${schema}.${table}`);
  }
  return rows.map((r) => ({ name: r.column_name, dataType: r.data_type }));
}

async function fetchPrimaryKey(
  client: pg.Client,
  schema: string,
  table: string,
): Promise<string[]> {
  const { rows } = await client.query<{ column_name: string }>(
    `SELECT kcu.column_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
      AND tc.table_name = kcu.table_name
     WHERE tc.table_schema = $1
       AND tc.table_name = $2
       AND tc.constraint_type = 'PRIMARY KEY'
     ORDER BY kcu.ordinal_position`,
    [schema, table],
  );
  if (rows.length === 0) {
    throw new Error(`No primary key found for ${schema}.${table}`);
  }
  return rows.map((r) => r.column_name);
}

function selectExpr(col: ColumnMeta): string {
  const q = `"${col.name}"`;
  if (
    col.dataType === 'timestamp with time zone' ||
    col.dataType === 'timestamp without time zone'
  ) {
    return `to_char(${q} AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS ${q}`;
  }
  return `(${q})::text AS ${q}`;
}

function pgCast(dataType: string): string {
  switch (dataType) {
    case 'uuid':
      return '::uuid';
    case 'bigint':
      return '::bigint';
    case 'integer':
      return '::integer';
    case 'smallint':
      return '::smallint';
    case 'boolean':
      return '::boolean';
    case 'timestamp with time zone':
      return '::timestamptz';
    case 'timestamp without time zone':
      return '::timestamp';
    default:
      return '';
  }
}

async function exportTable(
  client: pg.Client,
  schema: string,
  table: string,
  outDir: string,
  pageSize: number,
): Promise<{ rows: number; path: string }> {
  const cols = await fetchColumns(client, schema, table);
  const pk = await fetchPrimaryKey(client, schema, table);
  const pkCols = pk.map((name) => {
    const c = cols.find((cc) => cc.name === name);
    if (!c) throw new Error(`Primary key column not found in columns: ${name}`);
    return c;
  });

  const selectList = cols.map(selectExpr).join(', ');
  const orderBy = pk.map((c) => `"${c}"`).join(', ');

  const outPath = path.join(outDir, `${schema}.${table}.tsv`);
  const out = fs.createWriteStream(outPath, { encoding: 'utf-8' });

  const writeChunk = (chunk: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const ok = out.write(chunk, (err) => {
        if (err) reject(err);
      });
      if (ok) resolve();
      else out.once('drain', () => resolve());
    });

  let lastPk: string[] | null = null;
  let total = 0;

  try {
    for (;;) {
      const params: string[] = [];
      let where = '';
      if (lastPk !== null) {
        const placeholders = pkCols.map((c, i) => `$${i + 1}${pgCast(c.dataType)}`).join(', ');
        if (pkCols.length === 1) {
          where = `WHERE "${pkCols[0].name}" > ${placeholders}`;
        } else {
          const lhs = pkCols.map((c) => `"${c.name}"`).join(', ');
          where = `WHERE (${lhs}) > (${placeholders})`;
        }
        params.push(...lastPk);
      }
      params.push(String(pageSize));
      const limitIdx = params.length;

      const sql = `SELECT ${selectList} FROM "${schema}"."${table}" ${where} ORDER BY ${orderBy} LIMIT $${limitIdx}`;
      const result = await client.query<Record<string, string | null>>(sql, params);
      if (result.rows.length === 0) break;

      let buf = '';
      for (const row of result.rows) {
        const line = cols.map((c) => escapePgText(row[c.name])).join(FIELD_SEP);
        buf += line + ROW_SEP;
      }
      await writeChunk(buf);

      const lastRow = result.rows[result.rows.length - 1];
      lastPk = pkCols.map((c) => {
        const v = lastRow[c.name];
        if (v === null) {
          throw new Error(`Primary key column "${c.name}" is NULL in ${schema}.${table}`);
        }
        return v;
      });
      total += result.rows.length;

      if (result.rows.length < pageSize) break;
    }
  } finally {
    await new Promise<void>((resolve) => out.end(resolve));
  }

  return { rows: total, path: outPath };
}

export async function exportTables(opts: {
  client: pg.Client;
  schema: string;
  tables: string[];
  outDir: string;
  pageSize: number;
}): Promise<void> {
  const { client, schema, tables, outDir, pageSize } = opts;
  fs.mkdirSync(outDir, { recursive: true });
  await client.query("SET TIME ZONE 'UTC'");
  for (const table of tables) {
    const r = await exportTable(client, schema, table, outDir, pageSize);
    console.log(`  ${schema}.${table}: ${r.rows} rows -> ${r.path}`);
  }
}
