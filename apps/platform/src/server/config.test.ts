import { describe, expect, it } from "vitest";
import { checkConfig } from "./config";

const prod = {
  VERCEL_ENV: "production",
  DATABASE_URL: "postgresql://app:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres",
  DATABASE_SSL: "require",
  CRON_SECRET: "x".repeat(40),
  RESEND_API_KEY: "re_123",
  EMAIL_FROM: "LeanApp <no-reply@leanapp.io>",
  STRIPE_SECRET_KEY: "sk_live_abc123",
  STRIPE_WEBHOOK_SECRET: "whsec_abc123",
  INTEGRATIONS_ENCRYPTION_KEY: "a".repeat(64),
  ATTRIBUTION_IP_HASH_SECRET: "s".repeat(40),
};
const vars = (issues: { variable: string }[]) => issues.map((i) => i.variable);

describe("checkConfig", () => {
  it("accepts a complete production configuration", () => {
    expect(checkConfig(prod)).toEqual({ deployment: "production", errors: [], warnings: [] });
  });

  it("flags missing critical variables in production", () => {
    const r = checkConfig({ VERCEL_ENV: "production" });
    expect(vars(r.errors)).toEqual(["DATABASE_URL", "DATABASE_SSL", "CRON_SECRET"]);
    expect(vars(r.warnings)).toEqual(["RESEND_API_KEY", "STRIPE_SECRET_KEY", "INTEGRATIONS_ENCRYPTION_KEY", "ATTRIBUTION_IP_HASH_SECRET"]);
  });

  it("keeps deployed environments off local and test databases", () => {
    expect(vars(checkConfig({ ...prod, DATABASE_URL: "postgres://postgres:postgres@localhost:5432/platform_dev" }).errors)).toEqual(["DATABASE_URL"]);
    expect(vars(checkConfig({ ...prod, VERCEL_ENV: "preview", DATABASE_URL_TEST: prod.DATABASE_URL }).errors)).toEqual(["DATABASE_URL"]);
  });

  it("rejects a short cron secret, half an email config and unknown retention modes", () => {
    const r = checkConfig({ ...prod, CRON_SECRET: "short", EMAIL_FROM: "", EVENT_RETENTION: "yes" });
    expect(vars(r.errors).sort()).toEqual(["CRON_SECRET", "EMAIL_FROM", "EVENT_RETENTION"]);
  });

  it("requires https public URLs in production only", () => {
    expect(vars(checkConfig({ ...prod, PUBLIC_APP_URL: "http://app.leanapp.io" }).errors)).toEqual(["PUBLIC_APP_URL"]);
    expect(checkConfig({ DATABASE_URL: "postgres://localhost/x", PUBLIC_APP_URL: "http://localhost:3100" }).errors).toEqual([]);
  });

  it("only needs a database locally, including next start in CI", () => {
    expect(checkConfig({ NODE_ENV: "production", DATABASE_URL: "postgres://postgres:postgres@localhost:5432/x" })).toEqual({ deployment: "local", errors: [], warnings: [] });
    expect(vars(checkConfig({}).errors)).toEqual(["DATABASE_URL"]);
  });

  it("warns, never fails, about payments configuration", () => {
    const noStripe: Record<string, string | undefined> = { ...prod, STRIPE_SECRET_KEY: undefined, STRIPE_WEBHOOK_SECRET: undefined };
    expect(checkConfig(noStripe)).toMatchObject({ errors: [], warnings: [{ variable: "STRIPE_SECRET_KEY" }] });
    expect(vars(checkConfig({ ...prod, STRIPE_WEBHOOK_SECRET: "" }).warnings)).toEqual(["STRIPE_WEBHOOK_SECRET"]);
    expect(vars(checkConfig({ ...prod, STRIPE_SECRET_KEY: "pk_live_x" }).warnings)).toEqual(["STRIPE_SECRET_KEY"]);
    expect(vars(checkConfig({ ...prod, STRIPE_SECRET_KEY: "sk_test_x" }).warnings)).toEqual(["STRIPE_SECRET_KEY"]);
    expect(vars(checkConfig({ ...prod, STRIPE_WEBHOOK_SECRET: "secret" }).warnings)).toEqual(["STRIPE_WEBHOOK_SECRET"]);
    // Locally, no payments is fine.
    expect(checkConfig({ DATABASE_URL: "postgres://localhost/x" }).warnings).toEqual([]);
  });

  it("rejects a malformed integrations encryption key", () => {
    expect(vars(checkConfig({ ...prod, INTEGRATIONS_ENCRYPTION_KEY: "short" }).errors)).toEqual(["INTEGRATIONS_ENCRYPTION_KEY"]);
  });
});
