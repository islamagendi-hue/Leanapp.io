import "server-only";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { withSystem, type Db } from "@/lib/db";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { decryptSecret } from "@/lib/secret-box";
import { audit } from "@/modules/audit/service";
import { tenantTx, type TenantContext } from "@/modules/tenancy/context";
import { publicBaseUrl } from "@/server/env";
import { recordUnsubscribe } from "./consent";
import { DOMAIN } from "./email-content";
import { markIntegration, resendBase, sha256 } from "./integrations";

/**
 * Email for automations, on the customer's own Resend account:
 *   - templates with {{user.x}} / {{event.x}} variables (per environment);
 *   - the sending domain, created and verified through Resend's Domains API,
 *     with the DNS records Resend returns shown in the dashboard;
 *   - one-click unsubscribe (RFC 8058): every email carries a link and
 *     List-Unsubscribe headers with a random token; only its hash is stored
 *     (on the notification row). Using it adds an `email` suppression.
 * LeanApp's own RESEND_API_KEY is never used for customer email.
 */

// ── Templates ───────────────────────────────────────────────────────────────
export interface EmailTemplate {
  id: string;
  name: string;
  subject: string;
  body: string;
  updated_at: Date;
}

const templateSchema = z.object({
  name: z.string().trim().min(2, "Name the template (at least 2 characters).").max(80),
  subject: z.string().trim().min(1, "Enter a subject.").max(200),
  body: z.string().trim().min(1, "Enter the email text.").max(20_000),
});

export function listEmailTemplates(ctx: TenantContext, environmentId: string): Promise<EmailTemplate[]> {
  return tenantTx(ctx, "automations.read", (db) =>
    db.query<EmailTemplate>("select id, name, subject, body, updated_at from platform.email_templates where environment_id = $1 order by name", [environmentId]),
  );
}

export function getEmailTemplate(db: Db, environmentId: string, id: string): Promise<EmailTemplate | null> {
  return db.one<EmailTemplate>("select id, name, subject, body, updated_at from platform.email_templates where environment_id = $1 and id = $2", [environmentId, id]);
}

export async function saveEmailTemplate(ctx: TenantContext, environmentId: string, id: string | null, input: unknown): Promise<string> {
  const r = templateSchema.safeParse(input);
  if (!r.success) throw new ValidationError(r.error.issues[0]?.message ?? "Invalid template.");
  const t = r.data;
  return tenantTx(ctx, "automations.manage", async (db) => {
    const env = await db.one<{ app_id: string }>("select app_id from platform.environments where id = $1", [environmentId]);
    if (!env) throw new NotFoundError("Environment");
    const clash = await db.one("select 1 from platform.email_templates where environment_id = $1 and name = $2 and id <> coalesce($3::uuid, '00000000-0000-0000-0000-000000000000')", [environmentId, t.name, id]);
    if (clash) throw new ConflictError("A template with this name already exists.");
    let saved: { id: string } | null;
    if (id) {
      saved = await db.one<{ id: string }>(
        "update platform.email_templates set name = $3, subject = $4, body = $5, updated_at = now() where id = $1 and environment_id = $2 returning id",
        [id, environmentId, t.name, t.subject, t.body],
      );
      if (!saved) throw new NotFoundError("Template");
    } else {
      saved = await db.one<{ id: string }>(
        `insert into platform.email_templates (organization_id, app_id, environment_id, name, subject, body, created_by)
         values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [ctx.organizationId, env.app_id, environmentId, t.name, t.subject, t.body, ctx.userId],
      );
    }
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: id ? "email_template.updated" : "email_template.created", targetType: "email_template", targetId: saved!.id, metadata: { environment_id: environmentId, name: t.name } });
    return saved!.id;
  });
}

export async function deleteEmailTemplate(ctx: TenantContext, id: string): Promise<void> {
  await tenantTx(ctx, "automations.manage", async (db) => {
    const used = await db.one<{ name: string }>(
      `select name from platform.automations
        where status in ('draft', 'active', 'paused') and jsonb_path_exists(definition, '$.steps[*] ? (@.templateId == $id)', jsonb_build_object('id', $1::text)) limit 1`,
      [id],
    );
    if (used) throw new ConflictError(`The automation "${used.name}" uses this template.`);
    const row = await db.one<{ name: string }>("delete from platform.email_templates where id = $1 returning name", [id]);
    if (!row) throw new NotFoundError("Template");
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "email_template.deleted", targetType: "email_template", targetId: id, metadata: { name: row.name } });
  });
}

// ── Sending domain (Resend Domains API) ─────────────────────────────────────
export interface DnsRecord {
  record: string;
  name: string;
  type: string;
  value: string;
  ttl?: string;
  priority?: number;
  status?: string;
}

export interface EmailDomain {
  id: string;
  name: string;
  status: string;
  records: DnsRecord[];
  last_checked_at: Date;
}

async function resendCreds(db: Db, environmentId: string): Promise<{ id: string; apiKey: string }> {
  const row = await db.one<{ id: string; secret_ciphertext: string | null }>(
    "select id, secret_ciphertext from platform.integrations where environment_id = $1 and provider = 'resend'",
    [environmentId],
  );
  if (!row) throw new ValidationError("Connect Resend first: the domain is added to your own Resend account.");
  return { id: row.id, apiKey: decryptSecret(row.secret_ciphertext ?? "", `integration:${row.id}`) };
}

async function resendCall<T>(apiKey: string, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${resendBase()}${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      message = (JSON.parse(text) as { message?: string }).message?.slice(0, 200) ?? message;
    } catch {
      /* not JSON */
    }
    throw new ValidationError(`Resend said: ${message}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

const cleanRecords = (records: unknown): DnsRecord[] =>
  (Array.isArray(records) ? records : []).slice(0, 20).map((r: Record<string, unknown>) => ({
    record: String(r.record ?? ""), name: String(r.name ?? ""), type: String(r.type ?? ""), value: String(r.value ?? ""),
    ...(r.ttl !== undefined ? { ttl: String(r.ttl) } : {}), ...(typeof r.priority === "number" ? { priority: r.priority } : {}),
    ...(r.status !== undefined ? { status: String(r.status) } : {}),
  }));

export function getEmailDomain(ctx: TenantContext, environmentId: string): Promise<EmailDomain | null> {
  return tenantTx(ctx, "integrations.read", (db) =>
    db.one<EmailDomain>("select id, name, status, records, last_checked_at from platform.email_domains where environment_id = $1", [environmentId]),
  );
}

/** Adds the sending domain to the customer's Resend account and stores the DNS records to publish. */
export async function addEmailDomain(ctx: TenantContext, environmentId: string, input: { name?: unknown }): Promise<EmailDomain> {
  const name = String(input.name ?? "").trim().toLowerCase();
  if (!DOMAIN.test(name)) throw new ValidationError("Enter a domain like mail.example.com (no https://, no path).");
  const { creds, appId } = await tenantTx(ctx, "integrations.manage", async (db) => {
    const existing = await db.one("select 1 from platform.email_domains where environment_id = $1", [environmentId]);
    if (existing) throw new ConflictError("This environment already has a sending domain. Remove it first.");
    const env = await db.one<{ app_id: string }>("select app_id from platform.environments where id = $1", [environmentId]);
    if (!env) throw new NotFoundError("Environment");
    return { creds: await resendCreds(db, environmentId), appId: env.app_id };
  });
  const d = await resendCall<{ id?: string; name?: string; status?: string; records?: unknown }>(creds.apiKey, "POST", "/domains", { name });
  if (!d.id) throw new ValidationError("Resend didn't return a domain id.");
  return tenantTx(ctx, "integrations.manage", async (db) => {
    const row = await db.one<EmailDomain>(
      `insert into platform.email_domains (organization_id, app_id, environment_id, integration_id, name, provider_domain_id, status, records)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning id, name, status, records, last_checked_at`,
      [ctx.organizationId, appId, environmentId, creds.id, name, d.id, d.status ?? "not_started", JSON.stringify(cleanRecords(d.records))],
    );
    await markIntegration(db, creds.id, null);
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "email_domain.added", targetType: "email_domain", targetId: row!.id, metadata: { environment_id: environmentId, name } });
    return row!;
  });
}

/** Asks Resend to verify the DNS records (when `verify`) and refreshes the stored status and records. */
export async function refreshEmailDomain(ctx: TenantContext, environmentId: string, opts: { verify?: boolean } = {}): Promise<EmailDomain> {
  const { creds, domain } = await tenantTx(ctx, "integrations.manage", async (db) => {
    const domain = await db.one<{ id: string; provider_domain_id: string }>("select id, provider_domain_id from platform.email_domains where environment_id = $1", [environmentId]);
    if (!domain) throw new NotFoundError("Sending domain");
    return { creds: await resendCreds(db, environmentId), domain };
  });
  const path = `/domains/${encodeURIComponent(domain.provider_domain_id)}`;
  if (opts.verify) await resendCall(creds.apiKey, "POST", `${path}/verify`);
  const d = await resendCall<{ status?: string; records?: unknown }>(creds.apiKey, "GET", path);
  return tenantTx(ctx, "integrations.manage", async (db) => {
    const row = await db.one<EmailDomain>(
      "update platform.email_domains set status = $2, records = $3, last_checked_at = now() where id = $1 returning id, name, status, records, last_checked_at",
      [domain.id, d.status ?? "unknown", JSON.stringify(cleanRecords(d.records))],
    );
    if (row!.status === "verified") {
      await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "email_domain.verified", targetType: "email_domain", targetId: domain.id, metadata: { environment_id: environmentId, name: row!.name } });
    }
    return row!;
  });
}

/** Forgets the domain here (it stays in the customer's Resend account). */
export async function removeEmailDomain(ctx: TenantContext, environmentId: string): Promise<void> {
  await tenantTx(ctx, "integrations.manage", async (db) => {
    const row = await db.one<{ id: string; name: string }>("delete from platform.email_domains where environment_id = $1 returning id, name", [environmentId]);
    if (!row) throw new NotFoundError("Sending domain");
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "email_domain.removed", targetType: "email_domain", targetId: row.id, metadata: { environment_id: environmentId, name: row.name } });
  });
}

// ── Unsubscribe ─────────────────────────────────────────────────────────────
/** A new unsubscribe token for one email: the URL goes in the email, only the hash is stored. */
export function issueUnsubscribeToken(): { token: string; hash: string; url: string } {
  const token = randomBytes(24).toString("base64url");
  return { token, hash: sha256(token), url: `${publicBaseUrl()}/unsubscribe/${token}` };
}

const TOKEN = /^[A-Za-z0-9_-]{32}$/;

/** Whether the token belongs to an email we sent (for the confirmation page). */
export async function unsubscribeTokenValid(token: string): Promise<boolean> {
  if (!TOKEN.test(token)) return false;
  const row = await withSystem((db) => db.one("select 1 from platform.notifications where unsubscribe_token_hash = $1", [sha256(token)]));
  return Boolean(row);
}

/** Adds an `email` suppression for the person the email was sent to. Idempotent; false for unknown tokens. */
export async function applyUnsubscribe(token: string): Promise<boolean> {
  if (!TOKEN.test(token)) return false;
  return withSystem(async (db) => {
    const n = await db.one<{ organization_id: string; environment_id: string; user_key: string }>(
      "select organization_id, environment_id, user_key from platform.notifications where unsubscribe_token_hash = $1",
      [sha256(token)],
    );
    if (!n) return false;
    await recordUnsubscribe(db, { organizationId: n.organization_id, environmentId: n.environment_id, userKey: n.user_key, channel: "email", reason: "Unsubscribe link" });
    return true;
  });
}
