/**
 * db/ops/schedule.sql (the pg_cron worker schedule the deploy workflow installs).
 * Runs the real script with psql, as the workflow does, against a scratch
 * database where pg_cron, pg_net and Vault are replaced by small stubs with the
 * same call signatures (the CI Postgres image has none of them). Checks it is
 * idempotent, keeps the secret out of the job text, and builds the request the
 * worker endpoint expects.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const base = process.env.DATABASE_URL_TEST ?? "postgres://postgres:postgres@localhost:5432/platform_test";
const dbName = "platform_scheduler_test";
const url = base.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);

const STUBS = `
create schema cron; create schema vault; create schema net;
create table cron.job (jobid bigserial primary key, jobname text unique, schedule text, command text, active boolean default true);
create function cron.schedule(n text, s text, c text) returns bigint language sql as $$
  insert into cron.job (jobname, schedule, command) values (n, s, c)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning jobid $$;
create table vault.secrets (id uuid primary key default gen_random_uuid(), name text unique, secret text, description text);
create view vault.decrypted_secrets as select id, name, secret as decrypted_secret from vault.secrets;
create function vault.create_secret(s text, n text, d text) returns uuid language sql as $$ insert into vault.secrets (name, secret, description) values (n, s, d) returning id $$;
create function vault.update_secret(i uuid, s text) returns void language sql as $$ update vault.secrets set secret = s where id = i $$;
create table net.calls (url text, headers jsonb, timeout int);
create function net.http_get(url text, params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 5000) returns bigint
  language sql as $$ insert into net.calls values (url, headers, timeout_milliseconds); select 1::bigint $$;
`;

let script = "";

function run(vars: Record<string, string>) {
  const args = [url, "-q", "-v", "ON_ERROR_STOP=1", "-f", script];
  for (const [k, v] of Object.entries(vars)) args.push("-v", `${k}=${v}`);
  execFileSync("psql", args, { stdio: "pipe" });
}

async function query<T extends pg.QueryResultRow>(sql: string): Promise<T[]> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query<T>(sql)).rows;
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`drop database if exists ${dbName}`);
  await admin.query(`create database ${dbName}`);
  await admin.end();
  await query(STUBS);
  // The extensions are stubbed above; everything else runs as written.
  const original = readFileSync(path.join(import.meta.dirname, "../db/ops/schedule.sql"), "utf8");
  script = path.join(mkdtempSync(path.join(tmpdir(), "sched-")), "schedule.sql");
  writeFileSync(script, original.replace(/^create extension if not exists \w+;$/gm, ""));
});

afterAll(async () => {
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`drop database if exists ${dbName}`);
  await admin.end();
});

describe("scheduled worker setup", () => {
  it("installs the job, keeps the secret in Vault, and is idempotent", async () => {
    run({ app_url: "https://staging.example.test/", secret: "first-secret", schedule: "*/15 * * * *", bypass: "" });
    run({ app_url: "https://app.example.test", secret: "second-secret", schedule: "*/5 * * * *", bypass: "" });

    const jobs = await query<{ jobname: string; schedule: string; command: string }>("select jobname, schedule, command from cron.job order by jobname");
    expect(jobs.map((j) => j.jobname)).toEqual(["leanapp-cron-history-cleanup", "leanapp-process-events"]);
    const worker = jobs[1];
    expect(worker.schedule).toBe("*/5 * * * *");
    expect(worker.command).not.toContain("second-secret");
    expect(worker.command).toContain("https://app.example.test/api/internal/process-events");

    const secrets = await query<{ name: string; secret: string }>("select name, secret from vault.secrets order by name");
    expect(secrets).toEqual([
      { name: "leanapp_cron_secret", secret: "second-secret" },
      { name: "leanapp_protection_bypass", secret: "" },
    ]);

    // What pg_cron would run: one GET with the Bearer token and no bypass header.
    await query(worker.command);
    const [call] = await query<{ url: string; headers: Record<string, string>; timeout: number }>("select * from net.calls");
    expect(call).toEqual({ url: "https://app.example.test/api/internal/process-events", headers: { Authorization: "Bearer second-secret" }, timeout: 60000 });
  });

  it("sends the protection bypass header when one is configured", async () => {
    run({ app_url: "https://staging.example.test", secret: "s", schedule: "*/15 * * * *", bypass: "bypass-token" });
    const [job] = await query<{ command: string }>("select command from cron.job where jobname = 'leanapp-process-events'");
    await query("delete from net.calls");
    await query(job.command);
    const [call] = await query<{ headers: Record<string, string> }>("select headers from net.calls");
    expect(call.headers).toEqual({ Authorization: "Bearer s", "x-vercel-protection-bypass": "bypass-token" });
  });
});
