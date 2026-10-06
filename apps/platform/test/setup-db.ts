/**
 * Integration tests run against a real Postgres (RLS included). Each test file
 * starts from a freshly migrated `platform` schema in DATABASE_URL_TEST.
 */
import pg from "pg";
import { afterAll, beforeAll } from "vitest";
import { migrate } from "../scripts/migrate";
import { resetPool } from "@/lib/db";

const url = process.env.DATABASE_URL_TEST ?? "postgres://postgres:postgres@localhost:5432/platform_test";

beforeAll(async () => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query("drop schema if exists platform cascade");
  await c.end();
  await migrate(url, () => {});
  await resetPool(url);
});

afterAll(async () => {
  await resetPool();
});
