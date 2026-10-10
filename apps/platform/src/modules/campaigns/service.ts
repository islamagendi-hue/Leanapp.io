import "server-only";
import { z } from "zod";
import { msg } from "@/i18n/translate";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import {
  activateAutomation, archiveAutomation, createAutomation, getAutomation, listAutomations, pauseAutomation, updateAutomation, type AutomationRow, type RunRow,
} from "@/modules/automation/service";
import { audit } from "@/modules/audit/service";
import { sendStepNow } from "@/modules/automation/engine";
import { fill } from "@/modules/automation/messages";
import { deliveryOfAutomation, TEST_SENDS_PER_HOUR } from "@/modules/messaging/delivery";
import { loadDeliveryCredentials } from "@/modules/messaging/integrations";
import { checkMessagingStep, type StepIssue } from "@/modules/messaging/step-checks";
import type { DeliveryChannel, DeliveryCounts } from "@/modules/messaging/metrics";
import { tenantTx, type TenantContext } from "@/modules/tenancy/context";
import { buildCampaign, campaignStatus, CampaignError, type CampaignForm, type CampaignStatus } from "./definition";

/**
 * Campaigns on the automation engine (see ./definition.ts). Rights are the
 * automation rights: automations.read to view, automations.manage to change
 * and send. Sending, pausing and cancelling are the automation lifecycle;
 * the engine does the sending, with the same guardrails as flows.
 */

export interface CampaignStats {
  /** People the send reached (one run each). */
  recipients: number;
  /** Runs still waiting (quiet hours) or not stepped yet. */
  inProgress: number;
  /** Messages handed to the provider (push, email, WhatsApp) or queued for the app (in-app). */
  sent: number;
  failed: number;
  /** Not sent: frequency cap, no consent, no device or address, and similar. */
  skipped: number;
}

export interface Campaign extends AutomationRow {
  fired: boolean;
  campaignStatus: CampaignStatus;
  stats: CampaignStats;
}

const EMPTY: CampaignStats = { recipients: 0, inProgress: 0, sent: 0, failed: 0, skipped: 0 };

async function statsOf(ctx: TenantContext, ids: string[]): Promise<Map<string, CampaignStats & { fired: boolean }>> {
  if (!ids.length) return new Map();
  const rows = await tenantTx(ctx, "automations.read", (db) =>
    db.query<{ id: string; fired: boolean; recipients: number; in_progress: number; runs_failed: number; skipped: number; sent: number; failed: number }>(
      `select a.id, a.trigger_cursor is not null as fired,
              (select count(*)::int from platform.automation_runs r where r.automation_id = a.id) as recipients,
              (select count(*)::int from platform.automation_runs r where r.automation_id = a.id and r.status in ('pending', 'waiting', 'running')) as in_progress,
              (select count(*)::int from platform.automation_runs r where r.automation_id = a.id and r.status = 'failed') as runs_failed,
              (select count(*)::int from platform.automation_runs r where r.automation_id = a.id
                  and exists (select 1 from jsonb_array_elements(r.log) x where x->>'step' = '0' and x->>'outcome' = 'skipped')) as skipped,
              (select count(*)::int from platform.notifications n join platform.automation_runs r on r.id = n.automation_run_id
                where r.automation_id = a.id and n.status in ('sent', 'delivered', 'read', 'opened'))
                + (select count(*)::int from platform.in_app_messages m where m.automation_id = a.id) as sent,
              (select count(*)::int from platform.notifications n join platform.automation_runs r on r.id = n.automation_run_id
                where r.automation_id = a.id and n.status = 'failed') as failed
         from platform.automations a where a.id = any($1::uuid[])`,
      [ids],
    ),
  );
  return new Map(rows.map((r) => [r.id, { fired: r.fired, recipients: r.recipients, inProgress: r.in_progress, sent: r.sent, failed: r.failed + r.runs_failed, skipped: r.skipped }]));
}

function withStats(a: AutomationRow, s: (CampaignStats & { fired: boolean }) | undefined): Campaign {
  const { fired = false, ...stats } = s ?? { ...EMPTY, fired: false };
  return { ...a, fired, stats, campaignStatus: campaignStatus({ ...a, fired }) };
}

export async function listCampaigns(ctx: TenantContext, environmentId: string): Promise<Campaign[]> {
  const list = await listAutomations(ctx, environmentId, "campaign");
  const stats = await statsOf(ctx, list.map((a) => a.id));
  return list.map((a) => withStats(a, stats.get(a.id)));
}

export async function getCampaign(ctx: TenantContext, id: string): Promise<{ campaign: Campaign; runs: RunRow[]; delivery: Record<DeliveryChannel, DeliveryCounts> }> {
  const { automation, runs } = await getAutomation(ctx, id, { limit: 50 });
  if (automation.kind !== "campaign") throw new NotFoundError("Campaign");
  const [stats, delivery] = await Promise.all([statsOf(ctx, [id]), tenantTx(ctx, "automations.read", (db) => deliveryOfAutomation(db, id))]);
  return { campaign: withStats(automation, stats.get(id)), runs, delivery };
}

const nameSchema = z.string().trim().min(2, msg("Name the campaign.")).max(80);

function definitionOf(form: CampaignForm, timezone: string) {
  try {
    return buildCampaign(form, timezone);
  } catch (err) {
    if (err instanceof CampaignError) throw new ValidationError(err.message);
    throw err;
  }
}

/** Saves a draft campaign. */
export async function createCampaign(ctx: TenantContext, environmentId: string, input: { name?: unknown; form: CampaignForm; timezone: string }): Promise<{ id: string }> {
  const name = nameSchema.safeParse(input.name);
  if (!name.success) throw new ValidationError(name.error.issues[0].message);
  return createAutomation(ctx, environmentId, { name: name.data, definition: definitionOf(input.form, input.timezone) }, { kind: "campaign" });
}

/** Changes a campaign that hasn't gone out yet (a sent one-time campaign is kept as it was sent). */
export async function updateCampaign(ctx: TenantContext, id: string, input: { name?: unknown; form: CampaignForm; timezone: string }): Promise<void> {
  const { campaign } = await getCampaign(ctx, id);
  if (campaign.fired || campaign.status === "archived") throw new ConflictError(msg("This campaign was already sent or cancelled, so it can't be changed."));
  const name = nameSchema.safeParse(input.name);
  if (!name.success) throw new ValidationError(name.error.issues[0].message);
  await updateAutomation(ctx, id, { name: name.data, definition: definitionOf(input.form, input.timezone) });
}

/** Sends now, schedules, or resumes (a sent one-time campaign never sends again). */
export async function sendCampaign(ctx: TenantContext, id: string): Promise<void> {
  const { campaign } = await getCampaign(ctx, id);
  if (campaign.fired && campaign.definition.trigger.type === "once") throw new ConflictError(msg("This campaign was already sent."));
  await activateAutomation(ctx, id);
}

export async function pauseCampaign(ctx: TenantContext, id: string): Promise<void> {
  await getCampaign(ctx, id);
  await pauseAutomation(ctx, id);
}

/** Cancels the campaign: nothing more is sent, and messages still waiting (quiet hours) are dropped. */
export async function cancelCampaign(ctx: TenantContext, id: string): Promise<{ cancelled: number }> {
  await getCampaign(ctx, id);
  return archiveAutomation(ctx, id);
}

// ── Composer: validation and test send ─────────────────────────────────────
export interface CampaignCheck {
  issues: StepIssue[];
  /** Audience reach for the channel: members, and how many consent or suppression rules exclude. Null without an audience. */
  reach: { members: number; excluded: number } | null;
}

/**
 * What would stop or limit this campaign, before it is saved or sent: the
 * form itself, the provider connection, template approval and variables,
 * media against the provider's limits, and how many audience members are
 * excluded by consent or suppression on this channel.
 */
export async function checkCampaign(ctx: TenantContext, environmentId: string, form: CampaignForm, timezone: string): Promise<CampaignCheck> {
  let definition;
  try {
    definition = buildCampaign(form, timezone);
  } catch (err) {
    if (err instanceof CampaignError) return { issues: [{ level: "error", message: err.message }], reach: null };
    throw err;
  }
  return tenantTx(ctx, "automations.read", async (db) => {
    const env = await db.one<{ app_id: string }>("select app_id from platform.environments where id = $1", [environmentId]);
    if (!env) throw new NotFoundError("Environment");
    const step = definition.steps[0];
    const issues: StepIssue[] = step.type === "whatsapp" || step.type === "whatsapp_session" || step.type === "sms"
      ? await checkMessagingStep(db, { organizationId: ctx.organizationId, appId: env.app_id, environmentId }, step, { requireActive: true })
      : [];
    const audienceId = "audienceId" in definition.trigger ? definition.trigger.audienceId : null;
    const medium = step.type === "in_app" ? null : step.type;
    const reach = audienceId
      ? await db.one<{ members: number; excluded: number }>(
          `with m as (select user_key from platform.audience_members where audience_id = $1 and exited_at is null)
           select (select count(*)::int from m) as members,
                  (select count(*)::int from m where exists (
                     select 1 from platform.suppressions s where s.environment_id = $2 and s.user_key = m.user_key and (s.channel = 'marketing' or s.channel = $3))
                   or exists (select 1 from platform.consent_state c where c.environment_id = $2 and c.user_key = m.user_key and not c.granted
                                and (c.purpose = 'marketing' or ($3 = 'push' and c.purpose = 'push')))) as excluded`,
          [audienceId, environmentId, medium],
        )
      : null;
    if (reach && reach.members > 0 && reach.excluded === reach.members) issues.push({ level: "warning", message: msg("Everyone in this audience is opted out or suppressed for this channel.") });
    return { issues, reach };
  });
}

/**
 * Sends the composed WhatsApp or SMS message to one person (by user ID)
 * through the same code a campaign run uses. Consent, the 24-hour window,
 * approval and media checks apply; quiet hours and the frequency cap don't.
 */
export async function sendCampaignTest(ctx: TenantContext, environmentId: string, form: CampaignForm, userId: unknown, timezone: string): Promise<{ ok: boolean; message: string }> {
  const id = z.string().trim().min(1, msg("Enter the user ID of a person in this environment.")).max(200).safeParse(userId);
  if (!id.success) throw new ValidationError(id.error.issues[0].message);
  const definition = definitionOf(form, timezone);
  const step = definition.steps[0];
  if (step.type !== "whatsapp" && step.type !== "whatsapp_session" && step.type !== "sms") {
    throw new ValidationError(msg("Test this channel from Engage → Channels & delivery."));
  }
  return tenantTx(ctx, "automations.manage", async (db) => {
    const recent = await db.one<{ n: number }>(
      "select count(*)::int as n from platform.notifications where environment_id = $1 and automation_run_id is null and payload ? 'test' and created_at > now() - interval '1 hour'",
      [environmentId],
    );
    if (recent!.n >= TEST_SENDS_PER_HOUR) throw new ValidationError(fill(msg("At most {n} test messages an hour per environment. Try again later."), { n: TEST_SENDS_PER_HOUR }));
    const person = await db.one<{ properties: Record<string, unknown> }>("select properties from platform.app_users where environment_id = $1 and external_id = $2", [environmentId, id.data]);
    if (!person) throw new ValidationError(fill(msg('No person with the user ID "{id}" in this environment. The app must have identified them first.'), { id: id.data }));
    const creds = await loadDeliveryCredentials(db, environmentId);
    const r = await sendStepNow(db, creds, { organizationId: ctx.organizationId, environmentId, userKey: id.data, profile: person.properties, timezone }, step);
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "message.test_sent", targetType: "environment", targetId: environmentId, metadata: { channel: step.type, ok: r.outcome === "done" } });
    return { ok: r.outcome === "done", message: r.outcome === "done" ? r.detail : fill(msg("Not sent: {message}"), { message: r.detail }) };
  });
}
