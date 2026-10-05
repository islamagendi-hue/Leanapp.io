import "server-only";
import { z } from "zod";
import { sha256 } from "@/lib/crypto";
import { withSystem, type Db } from "@/lib/db";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { audit } from "@/modules/audit/service";
import { tenantTx, type TenantContext } from "@/modules/tenancy/context";
import { generateApiKey, generateSdkKey, keyKind, type EnvironmentType } from "./keys";

export interface SdkKeyRow {
  id: string;
  environment_id: string;
  key: string;
  label: string | null;
  status: "active" | "revoked";
  expires_at: Date | null;
  last_used_at: Date | null;
  created_at: Date;
}

export interface ApiKeyRow {
  id: string;
  environment_id: string;
  key_prefix: string;
  label: string | null;
  scopes: string[];
  status: "active" | "revoked";
  expires_at: Date | null;
  last_used_at: Date | null;
  created_at: Date;
}

async function envRow(db: Db, environmentId: string) {
  const env = await db.one<{ id: string; app_id: string; type: EnvironmentType }>(
    "select id, app_id, type from platform.environments where id = $1",
    [environmentId],
  );
  if (!env) throw new NotFoundError("Environment");
  return env;
}

/** Inserts a public SDK key inside an existing tenant transaction (used by app creation too). */
export async function insertSdkKey(db: Db, ctx: TenantContext, env: { id: string; app_id: string; type: EnvironmentType }, label: string | null) {
  const { key, hash } = generateSdkKey(env.type);
  const row = await db.one<{ id: string }>(
    `insert into platform.sdk_keys (organization_id, app_id, environment_id, key, key_hash, label, created_by)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [ctx.organizationId, env.app_id, env.id, key, hash, label, ctx.userId],
  );
  await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "sdk_key.created", targetType: "sdk_key", targetId: row!.id, metadata: { environment_id: env.id } });
  return { id: row!.id, key };
}

export function listKeys(ctx: TenantContext, appId: string) {
  return tenantTx(ctx, "credentials.read", async (db) => ({
    sdkKeys: await db.query<SdkKeyRow>(
      `select id, environment_id, key, label, status, expires_at, last_used_at, created_at
         from platform.sdk_keys where app_id = $1 order by created_at desc`,
      [appId],
    ),
    apiKeys: await db.query<ApiKeyRow>(
      `select id, environment_id, key_prefix, label, scopes, status, expires_at, last_used_at, created_at
         from platform.api_keys where app_id = $1 order by created_at desc`,
      [appId],
    ),
  }));
}

export function createSdkKey(ctx: TenantContext, environmentId: string, label?: string) {
  return tenantTx(ctx, "credentials.manage", async (db) => insertSdkKey(db, ctx, await envRow(db, environmentId), label?.slice(0, 80) || null));
}

/**
 * Rotation: issues a new key and schedules the old one to expire after a grace
 * period, so app builds already in users' hands keep sending while the new
 * build rolls out. graceHours = 0 revokes immediately.
 */
export function rotateSdkKey(ctx: TenantContext, keyId: string, graceHours = 72) {
  if (!Number.isFinite(graceHours) || graceHours < 0 || graceHours > 24 * 90) throw new ValidationError("Grace period must be 0–2160 hours.");
  return tenantTx(ctx, "credentials.manage", async (db) => {
    const old = await db.one<{ id: string; environment_id: string; label: string | null }>(
      "select id, environment_id, label from platform.sdk_keys where id = $1 and status = 'active' for update",
      [keyId],
    );
    if (!old) throw new NotFoundError("Key");
    const created = await insertSdkKey(db, ctx, await envRow(db, old.environment_id), old.label);
    if (graceHours === 0) {
      await db.query("update platform.sdk_keys set status = 'revoked', revoked_at = now() where id = $1", [keyId]);
    } else {
      await db.query(
        "update platform.sdk_keys set expires_at = least(coalesce(expires_at, 'infinity'), now() + make_interval(hours => $2)) where id = $1",
        [keyId, graceHours],
      );
    }
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "sdk_key.rotated", targetType: "sdk_key", targetId: keyId, metadata: { new_key_id: created.id, grace_hours: graceHours } });
    return created;
  });
}

export function revokeSdkKey(ctx: TenantContext, keyId: string) {
  return tenantTx(ctx, "credentials.manage", async (db) => {
    const row = await db.one("update platform.sdk_keys set status = 'revoked', revoked_at = now() where id = $1 and status = 'active' returning id", [keyId]);
    if (!row) throw new NotFoundError("Key");
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "sdk_key.revoked", targetType: "sdk_key", targetId: keyId });
  });
}

const apiKeySchema = z.object({
  label: z.string().trim().max(80).optional(),
  expiresInDays: z.coerce.number().int().min(1).max(730).optional(),
});

/** Returns the plaintext secret exactly once. */
export function createApiKey(ctx: TenantContext, environmentId: string, input: unknown = {}) {
  const r = apiKeySchema.safeParse(input);
  if (!r.success) throw new ValidationError(r.error.issues[0]?.message ?? "Invalid input.");
  return tenantTx(ctx, "credentials.manage", async (db) => {
    const env = await envRow(db, environmentId);
    const { key, hash, prefix } = generateApiKey(env.type);
    const row = await db.one<{ id: string }>(
      `insert into platform.api_keys (organization_id, app_id, environment_id, key_prefix, key_hash, label, expires_at, created_by)
       values ($1, $2, $3, $4, $5, $6, case when $7::int is null then null else now() + make_interval(days => $7::int) end, $8)
       returning id`,
      [ctx.organizationId, env.app_id, env.id, prefix, hash, r.data.label || null, r.data.expiresInDays ?? null, ctx.userId],
    );
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "api_key.created", targetType: "api_key", targetId: row!.id, metadata: { environment_id: env.id } });
    return { id: row!.id, key };
  });
}

export function revokeApiKey(ctx: TenantContext, keyId: string) {
  return tenantTx(ctx, "credentials.manage", async (db) => {
    const row = await db.one("update platform.api_keys set status = 'revoked', revoked_at = now() where id = $1 and status = 'active' returning id", [keyId]);
    if (!row) throw new NotFoundError("Key");
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "api_key.revoked", targetType: "api_key", targetId: keyId });
  });
}

// ── Ingestion authentication (system scope: the key *is* the tenant credential) ──
export interface IngestionPrincipal {
  kind: "sdk" | "api";
  keyId: string;
  organizationId: string;
  appId: string;
  environmentId: string;
  environmentType: EnvironmentType;
}

export async function authenticateIngestionKey(raw: string | null | undefined): Promise<IngestionPrincipal | null> {
  if (!raw) return null;
  const kind = keyKind(raw);
  if (!kind) return null;
  const table = kind === "sdk" ? "platform.sdk_keys" : "platform.api_keys";
  return withSystem(async (db) => {
    const row = await db.one<{ id: string; organization_id: string; app_id: string; environment_id: string; type: EnvironmentType; stale: boolean }>(
      `select k.id, k.organization_id, k.app_id, k.environment_id, e.type,
              (k.last_used_at is null or k.last_used_at < now() - interval '1 minute') as stale
         from ${table} k
         join platform.environments e on e.id = k.environment_id and e.status = 'active'
         join platform.apps a on a.id = k.app_id and a.status = 'active'
         join platform.organizations o on o.id = k.organization_id and o.status = 'active'
        where k.key_hash = $1 and k.status = 'active' and (k.expires_at is null or k.expires_at > now())`,
      [sha256(raw)],
    );
    if (!row) return null;
    if (row.stale) await db.query(`update ${table} set last_used_at = now() where id = $1`, [row.id]);
    return { kind, keyId: row.id, organizationId: row.organization_id, appId: row.app_id, environmentId: row.environment_id, environmentType: row.type };
  });
}
