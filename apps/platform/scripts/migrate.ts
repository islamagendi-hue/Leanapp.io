/**
 * Minimal forward-only migration runner. Applies db/migrations/*.sql in order,
 * each in its own transaction, recording applied files in platform.schema_migrations.
 *   DATABASE_URL=... npm run db:migrate
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";

export async function migrate(url: string, log: (m: string) => void = console.log): Promise<string[]> {
  const client = new pg.Client({
    connectionString: url,
    ssl: process.env.DATABASE_SSL === "require" ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  try {
    await client.query("create schema if not exists platform");
    await client.query(
      "create table if not exists platform.schema_migrations (name text primary key, applied_at timestamptz not null default now())",
    );
    const dir = path.join(import.meta.dirname, "../db/migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    const applied = new Set((await client.query("select name from platform.schema_migrations")).rows.map((r) => r.name));
    const ran: string[] = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      await client.query("begin");
      try {
        await client.query(readFileSync(path.join(dir, file), "utf8"));
        await client.query("insert into platform.schema_migrations (name) values ($1)", [file]);
        await client.query("commit");
        log(`applied ${file}`);
        ran.push(file);
      } catch (err) {
        await client.query("rollback");
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
    return ran;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  migrate(url).then(
    (ran) => console.log(ran.length ? `done (${ran.length} applied)` : "up to date"),
    (err) => {
      console.error(err.message);
      process.exit(1);
    },
  );
}
