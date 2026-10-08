import "server-only";
import { z } from "zod";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import {
  activateAutomation, archiveAutomation, createAutomation, getAutomation, listAutomations, pauseAutomation, updateAutomation, type AutomationRow, type RunRow,
} from "@/modules/automation/service";
import { deliveryOfAutomation } from "@/modules/messaging/delivery";
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

const nameSchema = z.string().trim().min(2, "Name the campaign.").max(80);

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
  if (campaign.fired || campaign.status === "archived") throw new ConflictError("This campaign was already sent or cancelled, so it can't be changed.");
  const name = nameSchema.safeParse(input.name);
  if (!name.success) throw new ValidationError(name.error.issues[0].message);
  await updateAutomation(ctx, id, { name: name.data, definition: definitionOf(input.form, input.timezone) });
}

/** Sends now, schedules, or resumes (a sent one-time campaign never sends again). */
export async function sendCampaign(ctx: TenantContext, id: string): Promise<void> {
  const { campaign } = await getCampaign(ctx, id);
  if (campaign.fired && campaign.definition.trigger.type === "once") throw new ConflictError("This campaign was already sent.");
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
