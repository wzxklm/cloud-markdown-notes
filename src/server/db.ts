import pg from "pg";
import type { AppConfig } from "./config";

const { Pool } = pg;

export type Database = {
  connect(): Promise<pg.PoolClient>;
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

export async function transaction<T>(db: Database, action: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("begin");
    const result = await action(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally { client.release(); }
}
