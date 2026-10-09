import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { msg } from "@/i18n/translate";
import { withSystem, withTenant, type Db } from "@/lib/db";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { log } from "@/lib/log";
import { audit } from "@/modules/audit/service";
import { assertCan } from "@/modules/rbac/authorize";
import { tenantTx, type TenantContext } from "@/modules/tenancy/context";
import { publicBaseUrl } from "@/server/env";
import { acceptedMimes, isMediaChannel, issueText, validateMediaForChannel, type ChannelCapability, type MediaChannel, type MediaCheck } from "./channel-rules";
import { checkFile, cleanFolder, cleanName, cleanTags, MediaValidationError } from "./policy";
import { EXTENSION_OF, type MediaKind, type MediaMime } from "./signature";
import { driverFor, uploadDriver, type StorageDriverName } from "./storage";

/**
 * The shared media library (docs/media.md). Rights: media.read to browse and
 * view files, media.manage to upload, replace, rename, publish and delete.
 * Every read and write runs under tenant RLS; the app id always comes from the
 * URL's app slug resolved for the member, never from the client.
 */

export interface MediaAsset {
  id: string;
  appId: string;
  name: string;
  folder: string | null;
  tags: string[];
  mime: MediaMime;
  kind: MediaKind;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  animated: boolean;
  checksum: string;
  publicAccess: boolean;
  /** The durable public URL while public access is on, else null. */
  publicUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
  createdByEmail: string | null;
  /** Live references (messages, templates) that block deleting. */
  usages: number;
}

interface Row {
  id: string;
  app_id: string;
  name: string;
  folder: string | null;
  tags: string[];
  mime_type: MediaMime;
  kind: MediaKind;
  size_bytes: string;
  width: number | null;
  height: number | null;
  animated: boolean;
  checksum_sha256: string;
  storage_driver: StorageDriverName;
  storage_key: string;
  public_token: string;
  public_access: boolean;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  created_by_email?: string | null;
  usages?: number;
}

/** Live usages: rows whose referencing automation still exists and isn't archived (other ref types always count). */
const LIVE_USAGES = `(select count(*)::int from platform.media_usages u
    left join platform.automations au on u.ref_type = 'automation' and au.id::text = u.ref_id
   where u.asset_id = m.id and (u.ref_type <> 'automation' or (au.id is not null and au.status <> 'archived')))`;

const SELECT = `select m.*, (select email from platform.users where id = m.created_by) as created_by_email, ${LIVE_USAGES} as usages from platform.media_assets m`;

export function publicMediaUrl(token: string, mime: MediaMime): string {
  return `${publicBaseUrl()}/m/${token}.${EXTENSION_OF[mime]}`;
}

function toAsset(r: Row): MediaAsset {
  return {
    id: r.id,
    appId: r.app_id,
    name: r.name,
    folder: r.folder,
    tags: r.tags,
    mime: r.mime_type,
    kind: r.kind,
    sizeBytes: Number(r.size_bytes),
    width: r.width,
    height: r.height,
    animated: r.animated,
    checksum: r.checksum_sha256,
    publicAccess: r.public_access,
    publicUrl: r.public_access && !r.deleted_at ? publicMediaUrl(r.public_token, r.mime_type) : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    createdByEmail: r.created_by_email ?? null,
    usages: r.usages ?? 0,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function liveRow(db: Db, appId: string, id: string, lock = false): Promise<Row> {
  if (!UUID.test(id)) throw new NotFoundError("Media file");
  const row = await db.one<Row>(`${SELECT} where m.id = $1 and m.app_id = $2 and m.deleted_at is null${lock ? " for update of m" : ""}`, [id, appId]);
  if (!row) throw new NotFoundError("Media file");
  return row;
}

export interface MediaFilter {
  q?: string;
  folder?: string;
  tag?: string;
  kind?: MediaKind;
  /** Only these types (the picker passes what a channel accepts). */
  mimes?: string[];
  limit?: number;
}

export async function listMedia(ctx: TenantContext, appId: string, f: MediaFilter = {}): Promise<{ assets: MediaAsset[]; folders: string[]; tags: string[] }> {
  return tenantTx(ctx, "media.read", async (db) => {
    const where = ["m.app_id = $1", "m.deleted_at is null"];
    const args: unknown[] = [appId];
    const add = (clause: (p: string) => string, v: unknown) => {
      args.push(v);
      where.push(clause(`$${args.length}`));
    };
    if (f.q?.trim()) add((p) => `(m.name ilike ${p} or exists (select 1 from unnest(m.tags) t where t ilike ${p}))`, `%${f.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    const folder = cleanFolder(f.folder);
    if (folder) add((p) => `(m.folder = ${p} or m.folder like ${p} || '/%')`, folder);
    if (f.tag?.trim()) add((p) => `${p} = any(m.tags)`, f.tag.trim().toLowerCase());
    if (f.kind) add((p) => `m.kind = ${p}`, f.kind);
    if (f.mimes) add((p) => `m.mime_type = any(${p}::text[])`, f.mimes);
    const limit = Math.min(Math.max(f.limit ?? 200, 1), 500);
    const rows = await db.query<Row>(`${SELECT} where ${where.join(" and ")} order by m.created_at desc, m.id limit ${limit}`, args);
    const facets = await db.one<{ folders: string[] | null; tags: string[] | null }>(
      `select (select array_agg(distinct folder order by folder) from platform.media_assets where app_id = $1 and deleted_at is null and folder is not null) as folders,
              (select array_agg(distinct t order by t) from platform.media_assets, unnest(tags) t where app_id = $1 and deleted_at is null) as tags`,
      [appId],
    );
    return { assets: rows.map(toAsset), folders: facets?.folders ?? [], tags: facets?.tags ?? [] };
  });
}

export async function getMedia(ctx: TenantContext, appId: string, id: string): Promise<MediaAsset> {
  return tenantTx(ctx, "media.read", async (db) => toAsset(await liveRow(db, appId, id)));
}

export interface UploadInput {
  bytes: Uint8Array;
  declaredType: string;
  filename: string;
  folder?: string | null;
  tags?: string | string[];
}

function checked(input: Pick<UploadInput, "bytes" | "declaredType">) {
  try {
    return checkFile(input.bytes, input.declaredType);
  } catch (e) {
    if (e instanceof MediaValidationError) throw new ValidationError(e.message);
    throw e;
  }
}

const storageKey = (orgId: string, appId: string, ext: string) => `org/${orgId}/app/${appId}/${randomUUID()}.${ext}`;

/**
 * Stores one file. The bytes are checked first (signature, size, dimensions);
 * the same file already in the app's library is returned instead of a copy.
 */
export async function uploadMedia(ctx: TenantContext, appId: string, input: UploadInput): Promise<{ asset: MediaAsset; duplicate: boolean }> {
  assertCan(ctx.role, "media.manage");
  const file = checked(input);
  const checksum = sha256(input.bytes);
  const existing = await tenantTx(ctx, "media.manage", (db) => db.one<Row>(`${SELECT} where m.app_id = $1 and m.checksum_sha256 = $2 and m.deleted_at is null limit 1`, [appId, checksum]));
  if (existing) return { asset: toAsset(existing), duplicate: true };
  // The app must be this tenant's (RLS) before anything is written to storage.
  const app = await tenantTx(ctx, "media.manage", (db) => db.one("select id from platform.apps where id = $1", [appId]));
  if (!app) throw new NotFoundError("App");

  const driver = uploadDriver();
  const key = storageKey(ctx.organizationId, appId, file.extension);
  await driver.put(key, input.bytes, file.mime, ctx.organizationId);
  try {
    const row = await tenantTx(ctx, "media.manage", async (db) => {
      const inserted = await db.one<{ id: string }>(
        `insert into platform.media_assets (organization_id, app_id, name, folder, tags, mime_type, kind, size_bytes, width, height, animated,
                                            checksum_sha256, storage_driver, storage_key, public_token, created_by, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16) returning id`,
        [ctx.organizationId, appId, cleanName(input.filename), cleanFolder(input.folder), cleanTags(input.tags), file.mime, file.kind, input.bytes.length,
          file.width, file.height, file.animated, checksum, driver.name, key, randomBytes(24).toString("base64url"), ctx.userId],
      );
      await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "media.uploaded", targetType: "media_asset", targetId: inserted!.id, metadata: { app_id: appId, mime: file.mime, size: input.bytes.length } });
      return liveRow(db, appId, inserted!.id);
    });
    return { asset: toAsset(row), duplicate: false };
  } catch (e) {
    await driver.delete(key).catch((err) => log.error("media.orphan_object", { error: err }));
    throw e;
  }
}

/**
 * Replaces a file's contents, keeping its id and public link so every message
 * using it picks up the new file. The new file must be the same kind (an
 * image stays an image) and still fit every channel it is used on.
 */
export async function replaceMedia(ctx: TenantContext, appId: string, id: string, input: Pick<UploadInput, "bytes" | "declaredType">): Promise<MediaAsset> {
  assertCan(ctx.role, "media.manage");
  const file = checked(input);
  const driver = uploadDriver();
  const key = storageKey(ctx.organizationId, appId, file.extension);
  // Check before writing anything.
  await tenantTx(ctx, "media.manage", async (db) => {
    const current = await liveRow(db, appId, id);
    if (current.kind !== file.kind) throw new ValidationError(msg("Replace a file with one of the same kind (image with image, video with video)."));
    await assertFitsUsages(db, id, { mime: file.mime, kind: file.kind, sizeBytes: input.bytes.length, width: file.width, height: file.height });
  });
  await driver.put(key, input.bytes, file.mime, ctx.organizationId);
  let old: { driver: StorageDriverName; key: string } | null = null;
  try {
    const row = await tenantTx(ctx, "media.manage", async (db) => {
      const current = await liveRow(db, appId, id, true);
      if (current.kind !== file.kind) throw new ValidationError(msg("Replace a file with one of the same kind (image with image, video with video)."));
      await assertFitsUsages(db, id, { mime: file.mime, kind: file.kind, sizeBytes: input.bytes.length, width: file.width, height: file.height });
      old = { driver: current.storage_driver, key: current.storage_key };
      await db.query(
        `update platform.media_assets set mime_type = $2, size_bytes = $3, width = $4, height = $5, animated = $6, checksum_sha256 = $7,
                storage_driver = $8, storage_key = $9, updated_by = $10 where id = $1`,
        [id, file.mime, input.bytes.length, file.width, file.height, file.animated, sha256(input.bytes), driver.name, key, ctx.userId],
      );
      await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "media.replaced", targetType: "media_asset", targetId: id, metadata: { mime: file.mime, size: input.bytes.length } });
      return liveRow(db, appId, id);
    });
    const prev = old as { driver: StorageDriverName; key: string } | null;
    if (prev) await driverFor(prev.driver).delete(prev.key).catch((err) => log.error("media.old_object_delete_failed", { error: err }));
    return toAsset(row);
  } catch (e) {
    await driver.delete(key).catch((err) => log.error("media.orphan_object", { error: err }));
    throw e;
  }
}

async function assertFitsUsages(db: Db, id: string, facts: { mime: string; kind: MediaKind; sizeBytes: number; width: number | null; height: number | null }) {
  const channels = await db.query<{ channel: string }>("select distinct channel from platform.media_usages where asset_id = $1 and channel is not null", [id]);
  for (const { channel } of channels) {
    if (!isMediaChannel(channel)) continue;
    const check = validateMediaForChannel(facts, { channel });
    if (!check.ok) throw new ValidationError(issueText(check.errors[0]));
  }
}

export async function updateMedia(ctx: TenantContext, appId: string, id: string, input: { name?: string; folder?: string | null; tags?: string | string[] }): Promise<void> {
  await tenantTx(ctx, "media.manage", async (db) => {
    const row = await liveRow(db, appId, id, true);
    const name = input.name === undefined ? row.name : cleanName(input.name, "");
    if (!name) throw new ValidationError(msg("Name the file."));
    await db.query("update platform.media_assets set name = $2, folder = $3, tags = $4, updated_by = $5 where id = $1", [
      id, name, input.folder === undefined ? row.folder : cleanFolder(input.folder), input.tags === undefined ? row.tags : cleanTags(input.tags), ctx.userId,
    ]);
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "media.updated", targetType: "media_asset", targetId: id, metadata: { name } });
  });
}

const PUBLIC_CHANNELS = ["push", "web_push", "in_app", "email", "whatsapp", "sms"];

/**
 * Turns the durable public link on or off. Off is refused while a live message
 * that providers fetch from that link uses the file.
 */
export async function setMediaPublic(ctx: TenantContext, appId: string, id: string, on: boolean): Promise<void> {
  await tenantTx(ctx, "media.manage", async (db) => {
    const row = await liveRow(db, appId, id, true);
    if (row.public_access === on) return;
    if (!on && (row.usages ?? 0) > 0) {
      const used = await db.one<{ n: number }>(
        `select count(*)::int as n from platform.media_usages u left join platform.automations au on u.ref_type = 'automation' and au.id::text = u.ref_id
          where u.asset_id = $1 and u.channel = any($2::text[]) and (u.ref_type <> 'automation' or (au.id is not null and au.status <> 'archived'))`,
        [id, PUBLIC_CHANNELS],
      );
      if (used && used.n > 0) throw new ConflictError(msg("Messages use this file's public link. Remove it from those messages first."));
    }
    await db.query("update platform.media_assets set public_access = $2, updated_by = $3 where id = $1", [id, on, ctx.userId]);
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "media.public_access_changed", targetType: "media_asset", targetId: id, metadata: { public: on } });
  });
}

/** Soft delete. Refused while live messages or templates use the file; the stored file is removed later by the purge job. */
export async function deleteMedia(ctx: TenantContext, appId: string, id: string): Promise<void> {
  await tenantTx(ctx, "media.manage", async (db) => {
    const row = await liveRow(db, appId, id, true);
    if ((row.usages ?? 0) > 0) throw new ConflictError(msg("Messages or templates use this file. Remove it from them first."));
    await db.query("update platform.media_assets set deleted_at = now(), deleted_by = $2, public_access = false where id = $1", [id, ctx.userId]);
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "media.deleted", targetType: "media_asset", targetId: id, metadata: { name: row.name } });
  });
}

/** The file's bytes for a member with media.read (the authorized file route). */
export async function readMediaFile(ctx: TenantContext, appId: string, id: string): Promise<{ bytes: Uint8Array; mime: MediaMime; name: string; checksum: string }> {
  const row = await tenantTx(ctx, "media.read", (db) => liveRow(db, appId, id));
  const obj = await driverFor(row.storage_driver).get(row.storage_key);
  if (!obj) throw new NotFoundError("Media file");
  return { bytes: obj.bytes, mime: row.mime_type, name: row.name, checksum: row.checksum_sha256 };
}

const TOKEN = /^[A-Za-z0-9_-]{32,64}$/;

/** The file behind a public link, while public access is on and it isn't deleted. Null otherwise. */
export async function readPublicMedia(token: string): Promise<{ bytes: Uint8Array; mime: MediaMime; checksum: string } | null> {
  if (!TOKEN.test(token)) return null;
  // Tenant-agnostic by nature (the token is the credential): an explicit, single-row lookup.
  const row = await withSystem((db) =>
    db.one<Row>("select * from platform.media_assets where public_token = $1 and public_access and deleted_at is null", [token]),
  );
  if (!row) return null;
  const obj = await driverFor(row.storage_driver).get(row.storage_key);
  return obj ? { bytes: obj.bytes, mime: row.mime_type, checksum: row.checksum_sha256 } : null;
}

export class MediaUnavailableError extends ValidationError {
  constructor(message: string, public readonly check?: MediaCheck) {
    super(message);
  }
}

export interface ResolvedMedia {
  assetId: string;
  url: string;
  mime: MediaMime;
  kind: MediaKind;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  name: string;
  check: MediaCheck;
}

/**
 * For senders (messaging adapters): the durable public URL and facts of an
 * asset, after checking it still exists in this app, is public, and fits the
 * channel. Throws MediaUnavailableError (no fallback, no fake URL) otherwise.
 * Runs under the organization's RLS scope.
 */
export async function resolveMediaForSend(organizationId: string, appId: string, assetId: string, channel: MediaChannel | ChannelCapability): Promise<ResolvedMedia> {
  const cap: ChannelCapability = typeof channel === "string" ? { channel } : channel;
  if (!UUID.test(assetId) || !UUID.test(appId)) throw new MediaUnavailableError(msg("The message's media file was not found."));
  const row = await withTenant({ organizationId, userId: null }, (db) =>
    db.one<Row>("select * from platform.media_assets where id = $1 and app_id = $2", [assetId, appId]),
  );
  if (!row) throw new MediaUnavailableError(msg("The message's media file was not found."));
  const check = validateMediaForChannel({ mime: row.mime_type, kind: row.kind, sizeBytes: Number(row.size_bytes), width: row.width, height: row.height, animated: row.animated, deleted: Boolean(row.deleted_at) }, cap);
  if (!check.ok) throw new MediaUnavailableError(issueText(check.errors[0]), check);
  if (check.requiresPublicUrl && !row.public_access) throw new MediaUnavailableError(msg("The message's media file has no public link, so the provider can't fetch it."), check);
  return {
    assetId: row.id,
    url: publicMediaUrl(row.public_token, row.mime_type),
    mime: row.mime_type,
    kind: row.kind,
    sizeBytes: Number(row.size_bytes),
    width: row.width,
    height: row.height,
    name: row.name,
    check,
  };
}

/** Step fields that hold a media asset id (push/in-app image, WhatsApp/MMS media). */
const MEDIA_FIELDS = ["imageAssetId", "mediaAssetId"] as const;

/** The media asset ids in an automation definition, with the step's channel. */
export function mediaRefsOf(definition: unknown): { assetId: string; channel: MediaChannel }[] {
  const steps = (definition as { steps?: unknown[] } | null)?.steps;
  if (!Array.isArray(steps)) return [];
  const out: { assetId: string; channel: MediaChannel }[] = [];
  for (const s of steps) {
    if (!s || typeof s !== "object") continue;
    const type = (s as { type?: unknown }).type;
    for (const f of MEDIA_FIELDS) {
      const v = (s as Record<string, unknown>)[f];
      if (typeof v === "string" && v && isMediaChannel(type)) out.push({ assetId: v, channel: type });
    }
  }
  return out;
}

/**
 * Records which media an automation (flow or campaign) uses, inside the
 * caller's transaction (the automation save). Each file must be in the same
 * app, not deleted, and fit the step's channel; a file used on a channel whose
 * provider fetches it gets its public link turned on. Usage rows of files the
 * automation no longer uses are removed.
 */
export async function syncAutomationMedia(db: Db, ctx: TenantContext, automationId: string, definition: unknown): Promise<void> {
  const refs = mediaRefsOf(definition);
  const auto = await db.one<{ app_id: string }>("select app_id from platform.automations where id = $1", [automationId]);
  if (!auto) return;
  const keep: string[] = [];
  for (const r of refs) {
    if (!UUID.test(r.assetId)) throw new ValidationError(msg("Choose a file from the media library."));
    const row = await db.one<Row>("select * from platform.media_assets where id = $1 and app_id = $2 and deleted_at is null for update", [r.assetId, auto.app_id]);
    if (!row) throw new ValidationError(msg("The chosen media file is not in this app's library."));
    const check = validateMediaForChannel({ mime: row.mime_type, kind: row.kind, sizeBytes: Number(row.size_bytes), width: row.width, height: row.height }, { channel: r.channel });
    if (!check.ok) throw new ValidationError(issueText(check.errors[0]));
    if (check.requiresPublicUrl && !row.public_access) await db.query("update platform.media_assets set public_access = true where id = $1", [row.id]);
    await db.query(
      `insert into platform.media_usages (organization_id, app_id, asset_id, ref_type, ref_id, channel, created_by)
       values ($1, $2, $3, 'automation', $4, $5, $6)
       on conflict (asset_id, ref_type, ref_id) do update set channel = excluded.channel`,
      [ctx.organizationId, auto.app_id, row.id, automationId, r.channel, ctx.userId],
    );
    keep.push(row.id);
  }
  await db.query("delete from platform.media_usages where ref_type = 'automation' and ref_id = $1 and not (asset_id = any($2::uuid[]))", [automationId, keep]);
}

/** Which types the picker offers for a channel. */
export const pickerMimes = (channel: MediaChannel) => acceptedMimes({ channel });

/**
 * Removes the stored files of assets deleted more than `graceDays` ago that
 * nothing references: no usage row, and the id or public token appears in no
 * automation definition and no email template of the organization. Rows stay
 * (purged_at set) for the audit trail. Run by the scheduled worker.
 */
export async function purgeDeletedMedia(opts: { graceDays?: number; limit?: number } = {}): Promise<{ purged: number; kept: number; failed: number }> {
  const graceDays = opts.graceDays ?? 7;
  const limit = opts.limit ?? 100;
  const candidates = await withSystem((db) =>
    db.query<{ id: string; organization_id: string; storage_driver: StorageDriverName; storage_key: string; referenced: boolean }>(
      `select m.id, m.organization_id, m.storage_driver, m.storage_key,
              (exists (select 1 from platform.media_usages u where u.asset_id = m.id)
               or exists (select 1 from platform.automations a where a.organization_id = m.organization_id
                           and (strpos(a.definition::text, m.id::text) > 0 or strpos(a.definition::text, m.public_token) > 0))
               or exists (select 1 from platform.email_templates t where t.organization_id = m.organization_id and strpos(t.body, m.public_token) > 0)) as referenced
         from platform.media_assets m
        where m.deleted_at is not null and m.purged_at is null and m.deleted_at < now() - make_interval(days => $1)
        order by m.deleted_at limit $2`,
      [graceDays, limit],
    ),
  );
  let purged = 0;
  let kept = 0;
  let failed = 0;
  for (const c of candidates) {
    if (c.referenced) {
      kept++;
      continue;
    }
    try {
      // Claim the row first (still deleted, still unreferenced), then remove the object.
      const claimed = await withSystem((db) =>
        db.one(
          `update platform.media_assets m set purged_at = now() where m.id = $1 and m.deleted_at is not null and m.purged_at is null
             and not exists (select 1 from platform.media_usages u where u.asset_id = m.id) returning id`,
          [c.id],
        ),
      );
      if (!claimed) {
        kept++;
        continue;
      }
      await driverFor(c.storage_driver).delete(c.storage_key);
      purged++;
    } catch (e) {
      failed++;
      // Unclaim so the next run retries the object delete.
      await withSystem((db) => db.query("update platform.media_assets set purged_at = null where id = $1", [c.id])).catch(() => {});
      log.error("media.purge_failed", { error: e });
    }
  }
  return { purged, kept, failed };
}
