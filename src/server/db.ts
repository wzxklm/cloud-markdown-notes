import pg from "pg";
import type { AppConfig } from "./config";

const { Pool } = pg;

export type Database = {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[]
  ): Promise<pg.QueryResult<T>>;
};

let pool: pg.Pool | undefined;

export function getDatabase(config: AppConfig): Database {
  pool ??= new Pool({
    connectionString: config.databaseUrl
  });

  return pool;
}

export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
