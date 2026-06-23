import dotenv from "dotenv";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const { Pool } = pg;

dotenv.config({ path: process.env.DOTENV_CONFIG_PATH ?? ".env.dev" });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required.");
}

const pool = new Pool({
  connectionString: databaseUrl
});

async function main() {
  await pool.query(`
    create table if not exists schema_migrations (
      id text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const migrationsDir = path.resolve("src/server/migrations");
  const migrationFiles = (await readdir(migrationsDir))
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of migrationFiles) {
    const existing = await pool.query("select 1 from schema_migrations where id = $1", [file]);
    if (existing.rowCount) {
      continue;
    }

    const sql = await readFile(path.join(migrationsDir, file), "utf8");
    await pool.query("begin");
    try {
      await pool.query(sql);
      await pool.query("insert into schema_migrations (id) values ($1)", [file]);
      await pool.query("commit");
      console.log(`Applied migration ${file}`);
    } catch (error) {
      await pool.query("rollback");
      throw error;
    }
  }
}

try {
  await main();
} finally {
  await pool.end();
}
