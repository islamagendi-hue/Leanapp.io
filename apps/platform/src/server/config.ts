/**
 * Deployment configuration check. Run at server start (instrumentation.ts) and
 * by the health endpoint, so a misconfigured deployment reports what is wrong
 * instead of half-working.
 *
 * Strictness follows the deployment, not NODE_ENV: `next start` in CI and the
 * browser tests run with NODE_ENV=production but are not a deployment.
 *   production  VERCEL_ENV=production: everything critical must be set.
 *   preview     VERCEL_ENV=preview: same database/secret rules (staging data only).
 *   local       anything else: only DATABASE_URL matters.
 *
 * Only variable names and reasons are reported, never values.
 */
export type Deployment = "production" | "preview" | "local";

export interface ConfigIssue {
  variable: string;
  problem: string;
}

export interface ConfigReport {
  deployment: Deployment;
  /** Critical: the app must not serve traffic as if healthy. */
  errors: ConfigIssue[];
  /** Degraded but safe (e.g. email disabled). */
  warnings: ConfigIssue[];
}

type Env = Record<string, string | undefined>;

export function deploymentOf(env: Env): Deployment {
  if (env.VERCEL_ENV === "production") return "production";
  if (env.VERCEL_ENV === "preview") return "preview";
  return "local";
}

const LOCAL_HOST = /@(localhost|127\.0\.0\.1|\[::1\]|host\.docker\.internal)(:|\/)/i;

export function checkConfig(env: Env = process.env): ConfigReport {
  const deployment = deploymentOf(env);
  const deployed = deployment !== "local";
  const errors: ConfigIssue[] = [];
  const warnings: ConfigIssue[] = [];
  const err = (variable: string, problem: string) => errors.push({ variable, problem });
  const warn = (variable: string, problem: string) => warnings.push({ variable, problem });

  const db = env.DATABASE_URL;
  if (!db) err("DATABASE_URL", "not set");
  else {
    if (!/^postgres(ql)?:\/\//.test(db)) err("DATABASE_URL", "must be a postgres:// URL");
    if (deployed && LOCAL_HOST.test(db)) err("DATABASE_URL", "points at a local database");
    if (deployed && env.DATABASE_URL_TEST && env.DATABASE_URL_TEST === db) err("DATABASE_URL", "is the same as DATABASE_URL_TEST");
  }
  if (deployed && env.DATABASE_SSL !== "require") err("DATABASE_SSL", 'must be "require" for a hosted database');

  if (deployed) {
    const secret = env.CRON_SECRET ?? "";
    if (!secret) err("CRON_SECRET", "not set; scheduled processing and deletions cannot run");
    else if (secret.length < 32) err("CRON_SECRET", "must be at least 32 characters");
  }

  if (env.EVENT_RETENTION && !["enforce", "report"].includes(env.EVENT_RETENTION)) {
    err("EVENT_RETENTION", 'must be unset, "report" or "enforce"');
  }

  const hasKey = Boolean(env.RESEND_API_KEY);
  const hasFrom = Boolean(env.EMAIL_FROM);
  if (hasKey !== hasFrom) err(hasKey ? "EMAIL_FROM" : "RESEND_API_KEY", "set both RESEND_API_KEY and EMAIL_FROM, or neither");
  else if (deployment === "production" && !hasKey) warn("RESEND_API_KEY", "not set; production sends no email");
  if (env.RESEND_API_KEY && !env.RESEND_API_KEY.startsWith("re_")) err("RESEND_API_KEY", "does not look like a Resend key");

  for (const name of ["PUBLIC_APP_URL", "PUBLIC_API_URL"]) {
    const v = env[name];
    if (!v) continue;
    let url: URL | null = null;
    try {
      url = new URL(v);
    } catch {
      err(name, "is not a URL");
    }
    if (url && deployment === "production" && url.protocol !== "https:") err(name, "must use https in production");
  }

  return { deployment, errors, warnings };
}
