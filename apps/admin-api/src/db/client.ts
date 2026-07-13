import { Kysely, MysqlDialect } from 'kysely';
import { createPool } from 'mysql2';
import { requireEnv } from '../env.js';
import type { Database } from './types.js';

let db: Kysely<Database> | undefined;

export const getDb = (): Kysely<Database> => {
  db ??= new Kysely<Database>({
    dialect: new MysqlDialect({
      pool: createPool({
        uri: requireEnv('DATABASE_URL'),
        // Lambda 1 コンテナが同時に捌くのは 1 リクエストのため接続は最小限
        connectionLimit: 2,
        // DATETIME は UTC で保存・解釈する
        timezone: 'Z',
      }),
    }),
  });
  return db;
};
