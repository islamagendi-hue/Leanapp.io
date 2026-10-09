import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const script = path.resolve(import.meta.dirname, "check-deploy-config.sh");
const repoRoot = path.resolve(import.meta.dirname, "../../../..");

// Placeholder values only; the script must never echo them back.
const complete = {
  DATABASE_URL: "postgres://user:pw-sentinel@db.example.invalid:5432/postgres",
  CRON_SECRET: "cron-sentinel",
  APP_URL: "https://app.example.invalid",
  VERCEL_DEPLOY_HOOK_URL: "https://api.vercel.com/v1/integrations/deploy/hook-sentinel",
  WORKER_SCHEDULE: "*/5 * * * *",
};

function run(env: Record<string, string>) {
  // Only PATH from the outer environment, so a developer's own env cannot leak in.
  const r = spawnSync("bash", [script], { env: { NODE_ENV: "test", PATH: process.env.PATH ?? "/usr/bin:/bin", ...env }, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function without(name: keyof typeof complete) {
  const env: Record<string, string> = { ...complete };
  delete env[name];
  return env;
}

describe("check-deploy-config.sh", () => {
  it("passes for production when everything is set, without printing values", () => {
    const r = run({ DEPLOY_TARGET: "production", ...complete });
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/sentinel|example\.invalid/);
  });

  it.each(Object.keys(complete) as (keyof typeof complete)[])("fails for production when %s is missing", (name) => {
    const r = run({ DEPLOY_TARGET: "production", ...without(name) });
    expect(r.code).toBe(1);
    expect(r.out).toContain(name);
    expect(r.out).toContain("Refusing to migrate or deploy");
    expect(r.out).not.toMatch(/sentinel|example\.invalid/);
  });

  it("treats an empty value as missing", () => {
    const r = run({ DEPLOY_TARGET: "production", ...complete, VERCEL_DEPLOY_HOOK_URL: "" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("VERCEL_DEPLOY_HOOK_URL");
  });

  it("fails for malformed URLs without printing them", () => {
    const r = run({ DEPLOY_TARGET: "production", ...complete, APP_URL: "http://app.example.invalid", DATABASE_URL: "mysql://x@example.invalid/db" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("APP_URL(must start with https://)");
    expect(r.out).toContain("DATABASE_URL(must start with postgres://");
    expect(r.out).not.toMatch(/example\.invalid/);
  });

  it("allows staging without a deploy hook, with a warning", () => {
    const r = run({ DEPLOY_TARGET: "staging", ...without("VERCEL_DEPLOY_HOOK_URL") });
    expect(r.code).toBe(0);
    expect(r.out).toContain("::warning::");
  });

  it("still requires the database URL, smoke URL and cron secret for staging", () => {
    for (const name of ["DATABASE_URL", "APP_URL", "CRON_SECRET", "WORKER_SCHEDULE"] as const) {
      expect(run({ DEPLOY_TARGET: "staging", ...without(name) }).code).toBe(1);
    }
  });

  it("refuses an unknown or missing target", () => {
    expect(run({ ...complete }).code).toBe(2);
    expect(run({ DEPLOY_TARGET: "prod", ...complete }).code).toBe(2);
  });
});

// The workflows are YAML; parse them with PyYAML when the machine has it (GitHub's
// ubuntu runners do). No YAML parser is a dependency of this package.
const hasPyYaml = spawnSync("python3", ["-c", "import yaml"]).status === 0;

function loadYaml(file: string): Record<string, unknown> {
  const r = spawnSync(
    "python3",
    ["-c", "import json,sys,yaml; print(json.dumps(yaml.load(open(sys.argv[1]), Loader=yaml.BaseLoader)))", file],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`${file} is not valid YAML:\n${r.stderr}`);
  return JSON.parse(r.stdout);
}

type Step = { name?: string; run?: string; if?: string; uses?: string };

describe.skipIf(!hasPyYaml)("deploy workflow", () => {
  const workflows = path.join(repoRoot, ".github/workflows");

  it.each(["ci.yml", "deploy.yml", "sdk-release-dry-run.yml"])("%s parses", (file) => {
    expect(loadYaml(path.join(workflows, file))).toHaveProperty("jobs");
  });

  const deploy = loadYaml(path.join(workflows, "deploy.yml")) as {
    on: Record<string, { workflows?: string[]; types?: string[] }>;
    jobs: { deploy: { if?: string; steps: Step[] } };
  };
  const ci = loadYaml(path.join(workflows, "ci.yml")) as { name: string; on: { push: { branches: string[] } } };
  const steps = deploy.jobs.deploy.steps;
  const index = (pred: (s: Step) => boolean) => steps.findIndex(pred);

  it("runs only after CI completes, never on a bare push or a manual run", () => {
    expect(Object.keys(deploy.on)).toEqual(["workflow_run"]);
    expect(deploy.on.workflow_run.workflows).toEqual([ci.name]);
    expect(deploy.on.workflow_run.types).toEqual(["completed"]);
    expect(deploy.jobs.deploy.if).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(deploy.jobs.deploy.if).toContain("github.event.workflow_run.event == 'push'");
    expect(ci.on.push.branches).toEqual(expect.arrayContaining(["main", "staging"]));
  });

  it("checks out the commit CI tested", () => {
    const checkout = steps.find((s) => s.uses?.startsWith("actions/checkout"));
    expect(JSON.stringify(checkout)).toContain("github.event.workflow_run.head_sha");
  });

  it("checks the configuration before migrations", () => {
    const check = index((s) => s.run?.includes("scripts/ci/check-deploy-config.sh") ?? false);
    const migrate = index((s) => s.run?.includes("db:migrate") ?? false);
    expect(check).toBeGreaterThanOrEqual(0);
    expect(migrate).toBeGreaterThan(check);
  });

  it("never skips the smoke test in production", () => {
    const smoke = steps.find((s) => s.run?.includes("npm run smoke"));
    expect(smoke).toBeDefined();
    // Production always starts a deployment (the hook is required), so the only
    // allowed condition is "a deployment was started".
    expect(smoke?.if ?? "").toBe("steps.hook.outputs.started == 'true'");
    const hook = steps.find((s) => s.name === "Start the Vercel deployment");
    expect(hook?.run).toContain('[ "$TARGET" = production ]');
  });
});
