import "server-only";
import { z } from "zod";
import type { Db } from "@/lib/db";
import { isUniqueViolation } from "@/lib/db";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { msg } from "@/i18n/translate";
import { purgeReportCache } from "@/modules/analytics/cache";
import { audit } from "@/modules/audit/service";
import { tenantTx, type TenantContext } from "@/modules/tenancy/context";
import type { ChannelRule, ClassifyContext, RuleConditions } from "./classify";
import { builtInChannel, CLICK_ID_CHANNELS, CUSTOM_KEY, type CustomChannel } from "./registry";

/**
 * Customer-defined channels and channel rules per app (migration 0034,
 * platform.channel_definitions / channel_rules). Reading needs
 * attribution.read; changing needs attribution.manage and is audited. Rules
 * apply at report time (classify.ts), so a change re-labels history; the
 * app's cached report results are dropped on every change.
 */

export interface CustomChannelRow extends CustomChannel {
  id: string;
  description: string;
  status: "active" | "archived";
  created_at: Date;
}

export interface ChannelRuleRow extends ChannelRule {
  note: string;
  status: "active" | "paused";
  created_at: Date;
}

const issue = (e: z.ZodError) => new ValidationError(e.issues[0]?.message ?? msg("Invalid input."), Object.fromEntries(e.issues.map((i) => [i.path.join(".") || "form", i.message])));

async function environmentsOf(db: Db, appId: string): Promise<string[]> {
  return (await db.query<{ id: string }>("select id from platform.environments where app_id = $1", [appId])).map((r) => r.id);
}

async function assertApp(db: Db, appId: string) {
  if (!z.uuid().safeParse(appId).success || !(await db.one("select 1 from platform.apps where id = $1", [appId]))) throw new NotFoundError("App");
}

export async function listChannelConfig(ctx: TenantContext, appId: string): Promise<{ channels: CustomChannelRow[]; rules: ChannelRuleRow[] }> {
  return tenantTx(ctx, "attribution.read", async (db) => {
    const channels = await db.query<CustomChannelRow>(
      `select id, key, label, channel_group as "group", description, status, created_at
         from platform.channel_definitions where app_id = $1 order by status, label`,
      [appId],
    );
    const rules = await db.query<ChannelRuleRow>(
      `select id, channel_key as channel, priority, conditions, note, status, created_at
         from platform.channel_rules where app_id = $1 order by status, priority, created_at`,
      [appId],
    );
    return { channels, rules };
  });
}

/** What reports classify with: active rules and active custom channels (inside the caller's transaction). */
export async function loadClassifyContext(db: Db, appId: string): Promise<Required<Pick<ClassifyContext, "rules" | "customChannels">>> {
  const customChannels = await db.query<CustomChannel>(
    `select key, label, channel_group as "group" from platform.channel_definitions where app_id = $1 and status = 'active'`,
    [appId],
  );
  const rules = await db.query<ChannelRule>(
    `select id, channel_key as channel, priority, conditions from platform.channel_rules where app_id = $1 and status = 'active' order by priority, id`,
    [appId],
  );
  return { rules, customChannels };
}

// ── Custom channels ─────────────────────────────────────────────────────────

const channelSchema = z.object({
  label: z.string().trim().min(1, msg("Name the channel.")).max(80, msg("The channel name is at most 80 characters.")),
  key: z.string().trim().toLowerCase().max(47).optional().transform((v) => v || undefined),
  group: z.enum(["paid", "organic", "owned", "referral", "custom"], msg("Choose the channel's group.")),
  description: z.string().trim().max(300).optional().transform((v) => v ?? ""),
});

/** custom_ + the label in snake case (ASCII letters and digits; other scripts fall back to a short id). */
export function customKeyFor(label: string, explicit?: string): string {
  if (explicit) return explicit.startsWith("custom_") ? explicit : `custom_${explicit}`;
  const slug = label.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  return `custom_${slug || Math.random().toString(36).slice(2, 10)}`;
}

export async function createCustomChannel(ctx: TenantContext, appId: string, input: unknown): Promise<CustomChannelRow> {
  const r = channelSchema.safeParse(input);
  if (!r.success) throw issue(r.error);
  const c = r.data;
  const key = customKeyFor(c.label, c.key);
  if (!CUSTOM_KEY.test(key)) throw new ValidationError(msg("The key is custom_ followed by 1–40 lowercase letters, digits or underscores."), { key: msg("Invalid key.") });
  return tenantTx(ctx, "attribution.manage", async (db) => {
    await assertApp(db, appId);
    try {
      await db.query("savepoint channel");
      const row = await db.one<CustomChannelRow>(
        `insert into platform.channel_definitions (organization_id, app_id, key, label, channel_group, description, created_by)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning id, key, label, channel_group as "group", description, status, created_at`,
        [ctx.organizationId, appId, key, c.label, c.group, c.description, ctx.userId],
      );
      await db.query("release savepoint channel");
      await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "channels.channel_created", targetType: "channel_definition", targetId: row!.id, metadata: { key, group: c.group } });
      await purgeReportCache(db, await environmentsOf(db, appId));
      return row!;
    } catch (err) {
      await db.query("rollback to savepoint channel");
      if (isUniqueViolation(err)) throw new ValidationError(msg("A channel with this key already exists."), { key: msg("Already used.") });
      throw err;
    }
  });
}

export async function setCustomChannelStatus(ctx: TenantContext, appId: string, id: string, status: "active" | "archived"): Promise<void> {
  if (!z.uuid().safeParse(id).success || !["active", "archived"].includes(status)) throw new ValidationError(msg("Invalid channel."));
  await tenantTx(ctx, "attribution.manage", async (db) => {
    const row = await db.one("update platform.channel_definitions set status = $3 where id = $1 and app_id = $2 returning id", [id, appId, status]);
    if (!row) throw new NotFoundError("Channel");
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "channels.channel_updated", targetType: "channel_definition", targetId: id, metadata: { status } });
    await purgeReportCache(db, await environmentsOf(db, appId));
  });
}

// ── Rules ───────────────────────────────────────────────────────────────────

const LABEL = /^[a-z0-9_.()\- ]{1,100}$/;
const list = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => [...new Set((Array.isArray(v) ? v : (v ?? "").split(",")).map((x) => x.trim().toLowerCase().replace(/\s+/g, "_")).filter(Boolean))].slice(0, 20))
  .refine((v) => v.every((x) => LABEL.test(x)), msg("Values are letters, digits, _ . - ( ) and spaces, up to 100 characters each."));
const optText = (max: number) => z.string().trim().max(max).optional().transform((v) => v || undefined);
const clickIdParams = Object.keys(CLICK_ID_CHANNELS).filter((k) => k !== "sccid");

const ruleSchema = z.object({
  channel: z.string().trim().min(1, msg("Choose the channel the rule puts touches on.")).max(47),
  priority: z.coerce.number().int().min(1, msg("Priority is 1–1000.")).max(1000, msg("Priority is 1–1000.")).default(100),
  source: list,
  medium: list,
  campaignPrefix: optText(100),
  referrerHost: optText(200).refine((v) => !v || /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(v.replace(/^www\./i, "")), msg("Enter a host name like news.example.com.")),
  clickIdParam: optText(20).refine((v) => !v || clickIdParams.includes(v), msg("Choose a known click id parameter.")),
  hasReferralId: z.union([z.boolean(), z.string()]).optional().transform((v) => (v === true || v === "on" || v === "true" ? true : undefined)),
  note: optText(200),
});

export function ruleConditions(r: z.output<typeof ruleSchema>): RuleConditions {
  const c: RuleConditions = {};
  if (r.source.length) c.source = r.source;
  if (r.medium.length) c.medium = r.medium;
  if (r.campaignPrefix) c.campaignPrefix = r.campaignPrefix.toLowerCase();
  if (r.referrerHost) c.referrerHost = r.referrerHost.toLowerCase().replace(/^www\./, "");
  if (r.clickIdParam) c.clickIdParam = r.clickIdParam;
  if (r.hasReferralId) c.hasReferralId = true;
  return c;
}

export async function createChannelRule(ctx: TenantContext, appId: string, input: unknown): Promise<ChannelRuleRow> {
  const r = ruleSchema.safeParse(input);
  if (!r.success) throw issue(r.error);
  const conditions = ruleConditions(r.data);
  if (Object.keys(conditions).length === 0) throw new ValidationError(msg("Give the rule at least one condition."), { source: msg("Add a condition.") });
  return tenantTx(ctx, "attribution.manage", async (db) => {
    await assertApp(db, appId);
    const key = r.data.channel;
    const exists = builtInChannel(key)
      ? !["unattributed"].includes(key)
      : Boolean(await db.one("select 1 from platform.channel_definitions where app_id = $1 and key = $2 and status = 'active'", [appId, key]));
    if (!exists) throw new ValidationError(msg("Choose an existing channel."), { channel: msg("Unknown channel.") });
    const row = await db.one<ChannelRuleRow>(
      `insert into platform.channel_rules (organization_id, app_id, channel_key, priority, conditions, note, created_by)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id, channel_key as channel, priority, conditions, note, status, created_at`,
      [ctx.organizationId, appId, key, r.data.priority, JSON.stringify(conditions), r.data.note ?? "", ctx.userId],
    );
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "channels.rule_created", targetType: "channel_rule", targetId: row!.id, metadata: { channel: key, priority: r.data.priority, conditions } });
    await purgeReportCache(db, await environmentsOf(db, appId));
    return row!;
  });
}

export async function setChannelRuleStatus(ctx: TenantContext, appId: string, id: string, status: "active" | "paused" | "deleted"): Promise<void> {
  if (!z.uuid().safeParse(id).success || !["active", "paused", "deleted"].includes(status)) throw new ValidationError(msg("Invalid rule."));
  await tenantTx(ctx, "attribution.manage", async (db) => {
    const row = status === "deleted"
      ? await db.one("delete from platform.channel_rules where id = $1 and app_id = $2 returning id", [id, appId])
      : await db.one("update platform.channel_rules set status = $3 where id = $1 and app_id = $2 returning id", [id, appId, status]);
    if (!row) throw new NotFoundError("Rule");
    await audit(db, {
      organizationId: ctx.organizationId, actorUserId: ctx.userId, action: status === "deleted" ? "channels.rule_deleted" : "channels.rule_updated",
      targetType: "channel_rule", targetId: id, metadata: { status },
    });
    await purgeReportCache(db, await environmentsOf(db, appId));
  });
}
