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
import { encryptionKeyProblem } from "@/lib/secret-box";

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

  // Payments (docs/billing.md): optional. Without them the billing page says payments aren't connected.
  const stripeKey = env.STRIPE_SECRET_KEY ?? "";
  const stripeHook = env.STRIPE_WEBHOOK_SECRET ?? "";
  if (stripeKey && !/^(sk|rk)_(live|test)_/.test(stripeKey)) warn("STRIPE_SECRET_KEY", "does not look like a Stripe secret key (sk_… or rk_…)");
  if (stripeHook && !stripeHook.startsWith("whsec_")) warn("STRIPE_WEBHOOK_SECRET", "does not look like a Stripe webhook signing secret (whsec_…)");
  if (Boolean(stripeKey) !== Boolean(stripeHook)) warn(stripeKey ? "STRIPE_WEBHOOK_SECRET" : "STRIPE_SECRET_KEY", "set both STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET; payments stay disconnected until then");
  else if (deployment === "production" && !stripeKey) warn("STRIPE_SECRET_KEY", "not set; payments are not connected and plans can't be bought");
  if (deployment === "production" && /^(sk|rk)_test_/.test(stripeKey)) warn("STRIPE_SECRET_KEY", "is a test-mode key in production");

  for (const name of ["PUBLIC_APP_URL", "PUBLIC_API_URL", "PUBLIC_LINK_URL"]) {
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

  // "Connect with …" OAuth apps for ad reporting (docs/integrations.md): optional, all-or-nothing per provider.
  for (const vars of [["META_APP_ID", "META_APP_SECRET"], ["GOOGLE_ADS_CLIENT_ID", "GOOGLE_ADS_CLIENT_SECRET", "GOOGLE_ADS_DEVELOPER_TOKEN"], ["TIKTOK_APP_ID", "TIKTOK_APP_SECRET"], ["SNAPCHAT_CLIENT_ID", "SNAPCHAT_CLIENT_SECRET"]]) {
    const set = vars.filter((v) => env[v]);
    if (set.length && set.length < vars.length) warn(vars.find((v) => !env[v])!, `set ${vars.join(", ")} together; "Connect with" stays off until then`);
  }
  if (env.GOOGLE_ADS_API_VERSION && !/^v\d{1,3}$/.test(env.GOOGLE_ADS_API_VERSION)) warn("GOOGLE_ADS_API_VERSION", "should look like v21");

  const encProblem = encryptionKeyProblem(env);
  if (encProblem) err("INTEGRATIONS_ENCRYPTION_KEY", encProblem);
  else if (deployed && !env.INTEGRATIONS_ENCRYPTION_KEY) warn("INTEGRATIONS_ENCRYPTION_KEY", "not set; ad-network, push, messaging and email credentials and webhooks can't be configured");
  if (deployed && !env.ATTRIBUTION_IP_HASH_SECRET) warn("ATTRIBUTION_IP_HASH_SECRET", "not set; clicks are recorded without an IP hash, so probabilistic matching is off");

  return { deployment, errors, warnings };
}
