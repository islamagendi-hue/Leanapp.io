import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Db } from "@/lib/db";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { decryptSecret, encryptSecret, secretsAvailable } from "@/lib/secret-box";
import { audit } from "@/modules/audit/service";
import { parseApnsKey, parseServiceAccount, type ApnsCredentials, type ServiceAccount } from "@/modules/push/messages";
import { allowedTokenUri } from "@/modules/push/transport";
import { tenantTx, type TenantContext } from "@/modules/tenancy/context";
import { deploymentOf } from "@/server/config";

/**
 * Per-environment delivery integrations whose credentials the customer gives
 * us: FCM (service account JSON), APNs (.p8 auth key) and Resend (API key, for
 * email to end users). Secrets are encrypted at rest (lib/secret-box) and never
 * returned to the browser; `config` keeps only non-secret settings for display.
 */
export const INTEGRATION_PROVIDERS = ["fcm", "apns", "resend"] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

export interface IntegrationRow {
  id: string;
  environment_id: string;
  provider: IntegrationProvider;
  config: Record<string, string>;
  status: "active" | "disabled" | "error";
  last_error: string | null;
  last_used_at: Date | null;
  updated_at: Date;
}

const aad = (id: string) => `integration:${id}`;

const apnsSchema = z.object({
  keyId: z.string().trim().regex(/^[A-Z0-9]{10}$/, "The Key ID is 10 letters and digits (Apple Developer → Keys)."),
  teamId: z.string().trim().regex(/^[A-Z0-9]{10}$/, "The Team ID is 10 letters and digits."),
  bundleId: z.string().trim().regex(/^[A-Za-z0-9.-]{3,155}$/, "Enter the app's bundle identifier, e.g. com.example.app."),
  apnsEnvironment: z.enum(["production", "sandbox"]),
  p8: z.string().trim().min(1, "Paste the contents of the .p8 key file.").max(10_000),
});

const resendSchema = z.object({
  apiKey: z.string().trim().regex(/^re_[A-Za-z0-9_]{8,200}$/, "Enter a Resend API key (starts with re_)."),
  from: z.string().trim().min(3).max(200).regex(/^(?:[^<>@\r\n]{0,100}<)?[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>?$/, 'Enter a sender like "My App <hello@example.com>".'),
});

export interface ResendCredentials {
  apiKey: string;
  from: string;
}

async function upsert(ctx: TenantContext, environmentId: string, provider: IntegrationProvider, config: Record<string, string>, secret: string): Promise<string> {
  if (!secretsAvailable()) throw new ValidationError("Credentials can't be stored: the server has no INTEGRATIONS_ENCRYPTION_KEY configured. Ask your LeanApp operator to set it.");
  return tenantTx(ctx, "integrations.manage", async (db) => {
    const env = await db.one<{ app_id: string }>("select app_id from platform.environments where id = $1", [environmentId]);
    if (!env) throw new NotFoundError("Environment");
    const existing = await db.one<{ id: string }>("select id from platform.integrations where environment_id = $1 and provider = $2", [environmentId, provider]);
    const id = existing?.id ?? randomUUID();
    const ciphertext = encryptSecret(secret, aad(id));
    if (existing) {
      await db.query("update platform.integrations set config = $2, secret_ciphertext = $3, status = 'active', last_error = null where id = $1", [id, JSON.stringify(config), ciphertext]);
    } else {
      await db.query(
        `insert into platform.integrations (id, organization_id, app_id, environment_id, provider, config, secret_ciphertext, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, ctx.organizationId, env.app_id, environmentId, provider, JSON.stringify(config), ciphertext, ctx.userId],
      );
    }
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "integration.configured", targetType: "integration", targetId: id, metadata: { environment_id: environmentId, provider, ...config } });
    return id;
  });
}

export async function configureFcm(ctx: TenantContext, environmentId: string, input: { serviceAccountJson?: unknown }): Promise<string> {
  let sa: ServiceAccount;
  try {
    sa = parseServiceAccount(String(input.serviceAccountJson ?? ""));
  } catch (err) {
    throw new ValidationError((err as Error).message);
  }
  if (!allowedTokenUri(sa.token_uri)) throw new ValidationError("The service account's token_uri must be https://oauth2.googleapis.com/token.");
  return upsert(ctx, environmentId, "fcm", { project_id: sa.project_id, client_email: sa.client_email }, JSON.stringify(sa));
}

export async function configureApns(ctx: TenantContext, environmentId: string, input: unknown): Promise<string> {
  const r = apnsSchema.safeParse(input);
  if (!r.success) throw new ValidationError(r.error.issues[0]?.message ?? "Invalid APNs settings.");
  try {
    parseApnsKey(r.data.p8);
  } catch (err) {
    throw new ValidationError((err as Error).message);
  }
  const { keyId, teamId, bundleId, apnsEnvironment, p8 } = r.data;
  return upsert(ctx, environmentId, "apns", { key_id: keyId, team_id: teamId, bundle_id: bundleId, environment: apnsEnvironment }, p8);
}

export async function configureResend(ctx: TenantContext, environmentId: string, input: unknown): Promise<string> {
  const r = resendSchema.safeParse(input);
  if (!r.success) throw new ValidationError(r.error.issues[0]?.message ?? "Invalid email settings.");
  return upsert(ctx, environmentId, "resend", { from: r.data.from }, r.data.apiKey);
}

export async function removeIntegration(ctx: TenantContext, id: string): Promise<void> {
  await tenantTx(ctx, "integrations.manage", async (db) => {
    const row = await db.one<{ provider: string; environment_id: string }>("delete from platform.integrations where id = $1 returning provider, environment_id", [id]);
    if (!row) throw new NotFoundError("Integration");
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "integration.removed", targetType: "integration", targetId: id, metadata: { ...row } });
  });
}

export function listIntegrations(ctx: TenantContext, environmentId: string): Promise<IntegrationRow[]> {
  return tenantTx(ctx, "integrations.read", (db) =>
    db.query<IntegrationRow>(
      `select id, environment_id, provider, config, status, last_error, last_used_at, updated_at
         from platform.integrations where environment_id = $1 and provider = any($2) order by provider`,
      [environmentId, INTEGRATION_PROVIDERS],
    ),
  );
}

export interface DeliveryCredentials {
  fcm?: { id: string; sa: ServiceAccount };
  apns?: { id: string; creds: ApnsCredentials };
  resend?: { id: string; creds: ResendCredentials };
  /** Providers configured but unreadable (e.g. encryption key missing or changed). */
  errors: Partial<Record<IntegrationProvider, string>>;
}

/** Decrypted credentials of an environment for the automation engine (inside its transaction). */
export async function loadDeliveryCredentials(db: Db, environmentId: string): Promise<DeliveryCredentials> {
  const rows = await db.query<{ id: string; provider: IntegrationProvider; config: Record<string, string>; secret_ciphertext: string | null }>(
    "select id, provider, config, secret_ciphertext from platform.integrations where environment_id = $1 and status <> 'disabled' and provider = any($2)",
    [environmentId, INTEGRATION_PROVIDERS],
  );
  const out: DeliveryCredentials = { errors: {} };
  for (const r of rows) {
    try {
      const secret = decryptSecret(r.secret_ciphertext ?? "", aad(r.id));
      if (r.provider === "fcm") out.fcm = { id: r.id, sa: JSON.parse(secret) };
      else if (r.provider === "apns") {
        out.apns = {
          id: r.id,
          creds: { keyId: r.config.key_id, teamId: r.config.team_id, bundleId: r.config.bundle_id, environment: r.config.environment as ApnsCredentials["environment"], privateKey: secret },
        };
      } else out.resend = { id: r.id, creds: { apiKey: secret, from: r.config.from } };
    } catch {
      out.errors[r.provider] = "credentials_unreadable";
    }
  }
  return out;
}

/** Records the outcome of using an integration (shown on the integrations page). */
export async function markIntegration(db: Db, id: string, error: string | null): Promise<void> {
  await db.query("update platform.integrations set last_used_at = now(), last_error = $2, status = case when $2::text is null then 'active' else status end where id = $1", [id, error?.slice(0, 300) ?? null]);
}

// ── Email to end users (customer's own Resend account) ─────────────────────
export async function sendCustomerEmail(creds: ResendCredentials, msg: { to: string; subject: string; text: string; tag: string }): Promise<{ ok: boolean; error: string | null; id?: string }> {
  const base = (deploymentOf(process.env) === "local" && process.env.RESEND_API_BASE_URL) || "https://api.resend.com";
  try {
    const res = await fetch(`${base}/emails`, {
      method: "POST",
      headers: { Authorization: `Bearer ${creds.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: creds.from, to: [msg.to], subject: msg.subject, text: msg.text, tags: [{ name: "automation", value: msg.tag }] }),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `Resend ${res.status}: ${text.slice(0, 200)}` };
    return { ok: true, error: null, id: (JSON.parse(text) as { id?: string }).id };
  } catch (err) {
    return { ok: false, error: (err as Error).message.slice(0, 300) };
  }
}
