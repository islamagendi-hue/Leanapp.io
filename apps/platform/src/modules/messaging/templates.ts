import "server-only";
import { z } from "zod";
import { msg } from "@/i18n/translate";
import { withSystem, withTenant } from "@/lib/db";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { log } from "@/lib/log";
import { audit } from "@/modules/audit/service";
import { fill } from "@/modules/automation/messages";
import { tenantTx, type TenantContext } from "@/modules/tenancy/context";
import { deleteTwilioTemplate, syncTwilioTemplates } from "@/modules/twilio/service";
import { placeholderCount } from "@/modules/whatsapp/template-text";
import { deleteTemplate, listTemplates, submitTemplate, syncTemplates, type WhatsAppTemplate } from "@/modules/whatsapp/service";
import { can, messagingProvider } from "./providers/registry";

/**
 * Message templates across providers:
 *   - synced provider templates (platform.whatsapp_templates): what the
 *     provider says exists, with its real status, category, language and
 *     rejection reason. Read-only here except delete, where the provider
 *     officially supports it;
 *   - local drafts (platform.message_template_drafts): written in LeanApp,
 *     not on any provider until submitted. Submitting creates the template on
 *     the provider (Meta: POST /{waba}/message_templates) and syncs, so the
 *     catalog shows the provider's own status.
 * Plus refresh: on demand, and from the scheduled worker for templates still
 * in review.
 */

export interface TemplateFilters {
  provider?: string;
  language?: string;
  status?: string;
  category?: string;
  q?: string;
}

export function filterTemplates<T extends Pick<WhatsAppTemplate, "provider" | "language" | "status" | "category" | "name" | "body_text">>(rows: T[], f: TemplateFilters): T[] {
  const q = f.q?.trim().toLowerCase();
  return rows.filter((r) =>
    (!f.provider || r.provider === f.provider) && (!f.language || r.language === f.language) && (!f.status || r.status === f.status.toUpperCase())
    && (!f.category || (r.category ?? "").toUpperCase() === f.category.toUpperCase())
    && (!q || r.name.toLowerCase().includes(q) || (r.body_text ?? "").toLowerCase().includes(q)));
}

export { listTemplates };

// ── Drafts ──────────────────────────────────────────────────────────────────
export interface TemplateDraftRow {
  id: string;
  provider: string;
  name: string;
  language: string;
  category: "MARKETING" | "UTILITY" | "AUTHENTICATION";
  header_text: string | null;
  body: string;
  footer: string | null;
  examples: string[];
  status: "draft" | "submitted" | "failed";
  external_id: string | null;
  last_error: string | null;
  submitted_at: Date | null;
  updated_at: Date;
}

const draftSchema = z
  .object({
    name: z.string().trim().regex(/^[a-z0-9_]{1,512}$/, msg("Template names use lowercase letters, digits and underscores (e.g. order_update).")),
    language: z.string().trim().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/, msg("Use a WhatsApp language code like en_US or ar.")),
    category: z.enum(["MARKETING", "UTILITY", "AUTHENTICATION"], msg("Choose a category.")),
    headerText: z.string().trim().max(60, msg("The header is at most 60 characters.")).optional().transform((v) => v || null),
    body: z.string().trim().min(1, msg("Enter the message text.")).max(1024, msg("The body is at most 1024 characters.")),
    footer: z.string().trim().max(60, msg("The footer is at most 60 characters.")).optional().transform((v) => v || null),
    examples: z.array(z.string().trim().max(200)).max(20).default([]),
  })
  .superRefine((d, ctx) => {
    const n = placeholderCount(d.body);
    for (let i = 1; i <= n; i++) if (!new RegExp(`\\{\\{\\s*${i}\\s*\\}\\}`).test(d.body)) ctx.addIssue({ code: "custom", message: fill(msg("Variables must be numbered in order: {{{n}}} is missing."), { n: i }) });
    if (d.examples.filter(Boolean).length < n) ctx.addIssue({ code: "custom", message: fill(msg("Give an example value for each of the {n} variables; Meta reviews them."), { n }) });
    if (/\{\{/.test(d.headerText ?? "")) ctx.addIssue({ code: "custom", message: msg("Header variables aren't supported in drafts yet; keep the header fixed.") });
  });

const DRAFT_COLUMNS = "id, provider, name, language, category, header_text, body, footer, examples, status, external_id, last_error, submitted_at, updated_at";

export function listDrafts(ctx: TenantContext, environmentId: string): Promise<TemplateDraftRow[]> {
  return tenantTx(ctx, "automations.read", (db) => db.query<TemplateDraftRow>(`select ${DRAFT_COLUMNS} from platform.message_template_drafts where environment_id = $1 order by updated_at desc`, [environmentId]));
}

export async function saveDraft(ctx: TenantContext, environmentId: string, id: string | null, input: unknown): Promise<string> {
  const r = draftSchema.safeParse(input);
  if (!r.success) throw new ValidationError(r.error.issues.find((i) => i.code === "custom")?.message ?? r.error.issues[0].message);
  const d = r.data;
  return tenantTx(ctx, "automations.manage", async (db) => {
    const env = await db.one<{ app_id: string }>("select app_id from platform.environments where id = $1", [environmentId]);
    if (!env) throw new NotFoundError("Environment");
    const clash = await db.one("select 1 from platform.message_template_drafts where environment_id = $1 and provider = 'whatsapp_cloud' and name = $2 and language = $3 and id <> coalesce($4::uuid, '00000000-0000-0000-0000-000000000000')", [environmentId, d.name, d.language, id]);
    if (clash) throw new ConflictError(msg("A draft with this name and language already exists."));
    const values = [d.name, d.language, d.category, d.headerText, d.body, d.footer, JSON.stringify(d.examples)];
    const row = id
      ? await db.one<{ id: string }>(
          `update platform.message_template_drafts set name = $3, language = $4, category = $5, header_text = $6, body = $7, footer = $8, examples = $9, status = 'draft', last_error = null, updated_at = now()
            where id = $1 and environment_id = $2 and status <> 'submitted' returning id`,
          [id, environmentId, ...values],
        )
      : await db.one<{ id: string }>(
          `insert into platform.message_template_drafts (organization_id, app_id, environment_id, provider, name, language, category, header_text, body, footer, examples, created_by)
           values ($1, $2, $3, 'whatsapp_cloud', $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
          [ctx.organizationId, env.app_id, environmentId, ...values, ctx.userId],
        );
    if (!row) throw new ConflictError(msg("A submitted draft can't be edited; change the template in WhatsApp Manager."));
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: id ? "message_template_draft.updated" : "message_template_draft.created", targetType: "message_template_draft", targetId: row.id, metadata: { environment_id: environmentId, name: d.name, language: d.language } });
    return row.id;
  });
}

export async function deleteDraft(ctx: TenantContext, id: string): Promise<void> {
  await tenantTx(ctx, "automations.manage", async (db) => {
    const row = await db.one<{ name: string }>("delete from platform.message_template_drafts where id = $1 returning name", [id]);
    if (!row) throw new NotFoundError("Draft");
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "message_template_draft.deleted", targetType: "message_template_draft", targetId: id, metadata: { name: row.name } });
  });
}

/**
 * Submits a draft to Meta for review. On success the draft is marked
 * submitted with Meta's id, and the catalog is re-synced so it shows the
 * provider's status (normally PENDING). A refusal is stored on the draft.
 */
export async function submitDraft(ctx: TenantContext, environmentId: string, id: string): Promise<{ status: string }> {
  if (!can("whatsapp_cloud", "template_create")) throw new ValidationError(msg("Template creation isn't available for this provider."));
  const draft = await tenantTx(ctx, "integrations.manage", (db) =>
    db.one<TemplateDraftRow>(`select ${DRAFT_COLUMNS} from platform.message_template_drafts where id = $1 and environment_id = $2`, [id, environmentId]),
  );
  if (!draft) throw new NotFoundError("Draft");
  if (draft.status === "submitted") throw new ConflictError(msg("This draft was already submitted."));
  let result: { id: string | null; status: string };
  try {
    result = await submitTemplate(ctx, environmentId, {
      name: draft.name, language: draft.language, category: draft.category, headerText: draft.header_text, body: draft.body, footer: draft.footer, examples: draft.examples,
    });
  } catch (err) {
    await tenantTx(ctx, "integrations.manage", (db) =>
      db.query("update platform.message_template_drafts set status = 'failed', last_error = $2, updated_at = now() where id = $1", [id, (err as Error).message.slice(0, 500)]),
    );
    throw err;
  }
  await tenantTx(ctx, "integrations.manage", async (db) => {
    await db.query("update platform.message_template_drafts set status = 'submitted', external_id = $2, last_error = null, submitted_at = now(), updated_at = now() where id = $1", [id, result.id]);
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "message_template.submitted", targetType: "message_template_draft", targetId: id, metadata: { environment_id: environmentId, name: draft.name, language: draft.language, provider_status: result.status } });
  });
  try {
    await syncTemplates(ctx, environmentId);
  } catch (err) {
    log.warn("templates.sync_after_submit_failed", { environment_id: environmentId, error: err });
  }
  return { status: result.status };
}

// ── Synced templates ────────────────────────────────────────────────────────
/** Syncs every connected provider with template discovery; a provider's failure is reported, not hidden. */
export async function syncAllTemplates(ctx: TenantContext, environmentId: string): Promise<{ provider: string; templates?: number; approved?: number; error?: string }[]> {
  const connected = await tenantTx(ctx, "integrations.manage", (db) =>
    db.query<{ provider: string }>("select provider from platform.integrations where environment_id = $1 and provider in ('whatsapp', 'twilio')", [environmentId]),
  );
  if (!connected.length) throw new ValidationError(msg("Connect WhatsApp (Meta) or Twilio first."));
  const out: { provider: string; templates?: number; approved?: number; error?: string }[] = [];
  for (const { provider } of connected) {
    const id = provider === "whatsapp" ? "whatsapp_cloud" : "twilio";
    if (id === "twilio") {
      const cfg = await tenantTx(ctx, "integrations.read", (db) => db.one<{ config: Record<string, string> }>("select config from platform.integrations where environment_id = $1 and provider = 'twilio'", [environmentId]));
      if (!cfg?.config.whatsapp_from) continue; // Twilio for SMS only: no WhatsApp templates to discover
    }
    try {
      out.push({ provider: id, ...(id === "twilio" ? await syncTwilioTemplates(ctx, environmentId) : await syncTemplates(ctx, environmentId)) });
    } catch (err) {
      out.push({ provider: id, error: (err as Error).message });
    }
  }
  return out;
}

/** Deletes a synced template on its provider (where the provider supports it). Refused while a draft, active or paused flow or campaign uses it. */
export async function deleteSyncedTemplate(ctx: TenantContext, environmentId: string, templateId: string): Promise<void> {
  const t = await tenantTx(ctx, "integrations.manage", async (db) => {
    const row = await db.one<{ provider: "whatsapp_cloud" | "twilio"; name: string; language: string; external_id: string | null }>(
      "select provider, name, language, external_id from platform.whatsapp_templates where id = $1 and environment_id = $2",
      [templateId, environmentId],
    );
    if (!row) throw new NotFoundError("Template");
    const used = await db.one<{ name: string }>(
      `select name from platform.automations
        where environment_id = $1 and status in ('draft', 'active', 'paused')
          and jsonb_path_exists(definition, '$.steps[*] ? (@.type == "whatsapp" && @.template == $name && @.language == $lang)', jsonb_build_object('name', $2::text, 'lang', $3::text)) limit 1`,
      [environmentId, row.name, row.language],
    );
    if (used) throw new ConflictError(fill(msg('"{name}" uses this template.'), { name: used.name }));
    return row;
  });
  const provider = messagingProvider(t.provider)!;
  if (!can(t.provider, "template_delete")) throw new ValidationError(fill(msg("{provider} templates can't be deleted from LeanApp."), { provider: provider.name }));
  if (t.provider === "twilio") await deleteTwilioTemplate(ctx, environmentId, t.external_id ?? "");
  else await deleteTemplate(ctx, environmentId, t.name, t.external_id);
  await tenantTx(ctx, "integrations.manage", (db) =>
    audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "message_template.deleted", targetType: "message_template", targetId: templateId, metadata: { environment_id: environmentId, provider: t.provider, name: t.name, language: t.language } }),
  );
}

// ── Background refresh (scheduled worker) ───────────────────────────────────
const REFRESH_EVERY_HOURS = 6;

/**
 * Re-syncs templates for environments where a template is still in review
 * (PENDING, IN_APPEAL, RECEIVED) or the last sync is older than a day, at
 * most every REFRESH_EVERY_HOURS per environment and provider. Bounded.
 */
export async function refreshTemplates(opts: { limit?: number; deadline?: number } = {}): Promise<{ refreshed: number; failed: number }> {
  const due = await withSystem((db) =>
    db.query<{ organization_id: string; environment_id: string; provider: "whatsapp_cloud" | "twilio" }>(
      `select organization_id, environment_id, provider from platform.whatsapp_templates
        group by organization_id, environment_id, provider
       having max(synced_at) < now() - make_interval(hours => $1)
          and (bool_or(status in ('PENDING', 'IN_APPEAL', 'RECEIVED')) or max(synced_at) < now() - interval '24 hours')
        limit $2`,
      [REFRESH_EVERY_HOURS, opts.limit ?? 20],
    ),
  );
  let refreshed = 0;
  let failed = 0;
  for (const d of due) {
    if (opts.deadline && Date.now() >= opts.deadline) break;
    const scope = { organizationId: d.organization_id, userId: null, system: true as const };
    try {
      if (d.provider === "twilio") await syncTwilioTemplates(scope, d.environment_id);
      else await syncTemplates(scope, d.environment_id);
      refreshed++;
    } catch (err) {
      failed++;
      // Don't retry every run: mark the rows as just checked; the integration shows the error.
      await withTenant({ organizationId: d.organization_id, userId: null }, (db) =>
        db.query("update platform.whatsapp_templates set synced_at = now() where environment_id = $1 and provider = $2", [d.environment_id, d.provider]),
      );
      log.warn("templates.refresh_failed", { environment_id: d.environment_id, provider: d.provider, error: err });
    }
  }
  return { refreshed, failed };
}
