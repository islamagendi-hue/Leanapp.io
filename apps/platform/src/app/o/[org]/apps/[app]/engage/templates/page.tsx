import Link from "next/link";
import {
  deleteSyncedTemplateAction, deleteTemplateDraftAction, saveTemplateDraftAction, submitTemplateDraftAction, syncAllTemplatesAction,
} from "@/app/actions/messaging";
import { ActionForm } from "@/components/ActionForm";
import { fmtDate } from "@/components/engage/shared";
import { getLang, getT } from "@/i18n/server";
import type { T } from "@/i18n/translate";
import { listIntegrations } from "@/modules/messaging/integrations";
import { CAPABILITY_LABELS, messagingProvider, type Capability } from "@/modules/messaging/providers/registry";
import { filterTemplates, listDrafts, listTemplates, type TemplateDraftRow } from "@/modules/messaging/templates";
import { can } from "@/modules/rbac/authorize";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export async function generateMetadata() {
  return { title: (await getT())("Message templates") };
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
const STATUS_TONE: Record<string, string> = { APPROVED: "text-accent-ink", REJECTED: "text-alert", PAUSED: "text-warn", DISABLED: "text-alert" };
const PROVIDER_LABEL: Record<string, string> = { whatsapp_cloud: "Meta", twilio: "Twilio" };
const TEMPLATE_CAPS: Capability[] = ["template_list", "template_create", "template_delete", "send_template", "send_session", "media"];

export default async function MessageTemplatesPage(props: PageProps<"/o/[org]/apps/[app]/engage/templates">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, environments } = await loadApp(org, app);
  requirePermission(ctx, "automations.read");
  const env = await pickEnvironment(environments, sp.env);
  const filters = { provider: one(sp.provider), language: one(sp.language), status: one(sp.status), category: one(sp.category), q: one(sp.q) };
  const [all, drafts, integrations] = await Promise.all([
    listTemplates(ctx, env.id),
    listDrafts(ctx, env.id),
    can(ctx.role, "integrations.read") ? listIntegrations(ctx, env.id) : Promise.resolve([]),
  ]);
  const templates = filterTemplates(all, filters);
  const manage = can(ctx.role, "automations.manage");
  const manageProviders = can(ctx.role, "integrations.manage");
  const meta = integrations.find((i) => i.provider === "whatsapp");
  const twilio = integrations.find((i) => i.provider === "twilio");
  const [t, lang] = await Promise.all([getT(), getLang()]);
  const distinct = (k: "language" | "status" | "category") => [...new Set(all.map((r) => r[k]).filter(Boolean) as string[])].sort();
  const base = `/o/${org}/apps/${app}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="h1">{t("Message templates")} <span className="pill border-line align-middle text-xs">{env.type}</span></h1>
          <p className="mt-1 max-w-3xl text-ink-2">
            {t("WhatsApp templates as your providers report them: real approval status, language and category. Synced templates live on the provider; drafts live only in LeanApp until you submit them.")}{" "}
            <Link className="underline" href={`${base}/engage/email-templates?env=${env.type}`}>{t("Email templates")}</Link>
          </p>
        </div>
        {manageProviders && (meta || twilio) && <ActionForm action={syncAllTemplatesAction.bind(null, org, app, env.id)} submitLabel={t("Sync from providers")} buttonClass="btn-secondary" />}
      </div>

      <section className="card space-y-2">
        <h2 className="h2">{t("Providers")}</h2>
        {!meta && !twilio && (
          <p className="text-sm text-warn">
            {t("No WhatsApp provider is connected in this environment.")}{" "}
            <Link className="underline" href={`${base}/settings/dev-ops/channels?env=${env.type}`}>{t("Connect one in Settings → Dev Ops → Channels")}</Link>
          </p>
        )}
        <div className="overflow-x-auto">
          <table className="table text-sm">
            <thead><tr><th>{t("Provider")}</th><th>{t("Connection")}</th>{TEMPLATE_CAPS.map((c) => <th key={c}>{t(CAPABILITY_LABELS[c])}</th>)}</tr></thead>
            <tbody>
              {(["whatsapp_cloud", "twilio"] as const).map((id) => {
                const p = messagingProvider(id)!;
                const row = id === "twilio" ? twilio : meta;
                return (
                  <tr key={id}>
                    <td>{p.name}</td>
                    <td className={row ? (row.last_error ? "text-alert" : "text-accent-ink") : "text-ink-3"}>{row ? (row.last_error ? t("Error") : t("Connected")) : t("Not connected")}</td>
                    {TEMPLATE_CAPS.map((c) => <td key={c}><CapabilityBadge status={p.capabilities[c]} t={t} /></td>)}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="help">{t("Implemented: LeanApp does it. Provider supports: documented by the provider, not built in LeanApp yet. Not available: the provider doesn't offer it, or it couldn't be confirmed.")}</p>
      </section>

      <section className="card space-y-4">
        <h2 className="h2">{t("Synced templates")}</h2>
        <form className="flex flex-wrap items-end gap-3" method="get">
          <input type="hidden" name="env" value={env.type} />
          <label className="block"><span className="label">{t("Search")}</span><input name="q" className="input" defaultValue={filters.q} placeholder={t("Name or text")} /></label>
          <Select name="provider" label={t("Provider")} value={filters.provider} options={["whatsapp_cloud", "twilio"].map((p) => [p, PROVIDER_LABEL[p]])} t={t} />
          <Select name="language" label={t("Language")} value={filters.language} options={distinct("language").map((l) => [l, l])} t={t} />
          <Select name="status" label={t("Status")} value={filters.status} options={distinct("status").map((s) => [s, s.toLowerCase()])} t={t} />
          <Select name="category" label={t("Category")} value={filters.category} options={distinct("category").map((c) => [c, c.toLowerCase()])} t={t} />
          <button className="btn-secondary" type="submit">{t("Filter")}</button>
        </form>
        {templates.length === 0 ? (
          <p className="text-sm text-ink-3">{all.length ? t("No template matches these filters.") : t("No templates synced yet. Create templates in WhatsApp Manager or the Twilio Console (or submit a draft below), then sync.")}</p>
        ) : (
          <div className="space-y-3">
            {templates.map((tp) => (
              <article key={tp.id} className="rounded-lg border border-line p-3 text-sm" data-template={tp.name}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p><code className="font-mono">{tp.name}</code> · {tp.language} · {tp.category?.toLowerCase() ?? "—"} · {PROVIDER_LABEL[tp.provider]}</p>
                    <p className={STATUS_TONE[tp.status] ?? "text-ink-3"}>
                      {tp.status.toLowerCase()}{tp.rejected_reason ? ` · ${t("reason: {reason}", { reason: tp.rejected_reason.toLowerCase().replace(/_/g, " ") })}` : ""}
                      {tp.quality_score ? ` · ${t("quality: {score}", { score: tp.quality_score.toLowerCase() })}` : ""}
                    </p>
                    <p className="text-xs text-ink-3">{t("Synced {date}", { date: fmtDate(tp.synced_at, lang) })}</p>
                  </div>
                  {manageProviders && messagingProvider(tp.provider)?.capabilities.template_delete === "implemented" && (
                    <ActionForm action={deleteSyncedTemplateAction.bind(null, org, app, env.id, tp.id)} submitLabel={t("Delete on provider")} buttonClass="btn-danger"
                      confirm={t('Delete "{name}" ({language}) in your provider account? This can\'t be undone.', { name: tp.name, language: tp.language })} />
                  )}
                </div>
                <div className="mt-2 max-w-xl space-y-1 rounded-lg bg-paper-2 p-3" dir="auto">
                  {tp.header_format && tp.header_format !== "TEXT" && <p className="text-xs text-ink-3">{t("Header: {kind} (choose a media file when sending)", { kind: tp.header_format.toLowerCase() })}</p>}
                  {tp.header_text && <p className="font-medium">{tp.header_text}</p>}
                  <p className="whitespace-pre-wrap">{tp.body_text}</p>
                  {tp.footer_text && <p className="text-xs text-ink-3">{tp.footer_text}</p>}
                </div>
                {tp.variables.length > 0 && <p className="mt-1 text-xs text-ink-3">{t("Variables: {list}", { list: tp.variables.map((v) => `{{${v}}}`).join(", ") })}</p>}
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="card space-y-4">
        <h2 className="h2">{t("Drafts")}</h2>
        <p className="text-sm text-ink-2">{t("Drafts are only in LeanApp. Submitting one creates the template in your WhatsApp Business account (Meta) for review; it then appears above with Meta's status.")}</p>
        {drafts.length === 0 && <p className="text-sm text-ink-3">{t("No drafts.")}</p>}
        {drafts.map((d) => <Draft key={d.id} d={d} org={org} app={app} envId={env.id} manage={manage} canSubmit={manageProviders && Boolean(meta)} t={t} />)}
        {manage && (
          <details>
            <summary className="cursor-pointer text-sm font-medium">{t("New draft")}</summary>
            <ActionForm action={saveTemplateDraftAction.bind(null, org, app, env.id, null)} submitLabel={t("Save draft")} className="mt-3 max-w-2xl space-y-3">
              <DraftFields t={t} />
            </ActionForm>
          </details>
        )}
      </section>
    </div>
  );
}

function CapabilityBadge({ status, t }: { status: string; t: T }) {
  if (status === "implemented") return <span className="text-accent-ink">{t("Implemented")}</span>;
  if (status === "provider_supported") return <span className="text-ink-2">{t("Provider supports")}</span>;
  return <span className="text-ink-3">{t("Not available")}</span>;
}

function Select({ name, label, value, options, t }: { name: string; label: string; value?: string; options: [string, string][]; t: T }) {
  return (
    <label className="block"><span className="label">{label}</span>
      <select name={name} className="input" defaultValue={value ?? ""}>
        <option value="">{t("All")}</option>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}

function DraftFields({ d, t }: { d?: TemplateDraftRow; t: T }) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block"><span className="label">{t("Name")}</span><input name="name" className="input font-mono" defaultValue={d?.name} placeholder="order_update" required pattern="[a-z0-9_]+" /></label>
        <label className="block"><span className="label">{t("Language code")}</span><input name="language" className="input font-mono" defaultValue={d?.language ?? "ar"} required /></label>
        <label className="block"><span className="label">{t("Category")}</span>
          <select name="category" className="input" defaultValue={d?.category ?? "MARKETING"}>
            <option value="MARKETING">{t("Marketing")}</option><option value="UTILITY">{t("Utility")}</option><option value="AUTHENTICATION">{t("Authentication")}</option>
          </select>
        </label>
      </div>
      <label className="block"><span className="label">{t("Header (optional, fixed text)")}</span><input name="headerText" className="input" maxLength={60} defaultValue={d?.header_text ?? ""} dir="auto" /></label>
      <label className="block"><span className="label">{t("Body: use {a}, {b} … for variables", { a: "{{1}}", b: "{{2}}" })}</span><textarea name="body" className="input min-h-28" maxLength={1024} required defaultValue={d?.body} dir="auto" /></label>
      <label className="block"><span className="label">{t("Footer (optional)")}</span><input name="footer" className="input" maxLength={60} defaultValue={d?.footer ?? ""} dir="auto" /></label>
      <label className="block"><span className="label">{t("Example value for each variable, one per line (Meta reviews them)")}</span><textarea name="examples" className="input min-h-16" defaultValue={d?.examples.join("\n")} dir="auto" /></label>
    </>
  );
}

function Draft({ d, org, app, envId, manage, canSubmit, t }: { d: TemplateDraftRow; org: string; app: string; envId: string; manage: boolean; canSubmit: boolean; t: T }) {
  return (
    <article className="space-y-2 rounded-lg border border-line p-3 text-sm" data-draft={d.name}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p><code className="font-mono">{d.name}</code> · {d.language} · {d.category.toLowerCase()} · <span className="pill border-line text-xs">{t("Local draft")}</span></p>
          <p className={d.status === "failed" ? "text-alert" : "text-ink-3"}>
            {d.status === "submitted" ? t("Submitted to WhatsApp (id {id}); its status is on the synced template.", { id: d.external_id ?? "—" }) : d.status === "failed" ? t("Submission refused: {error}", { error: d.last_error ?? "" }) : t("Not submitted")}
          </p>
        </div>
        {manage && (
          <div className="flex flex-wrap gap-2">
            {d.status !== "submitted" && canSubmit && <ActionForm action={submitTemplateDraftAction.bind(null, org, app, envId, d.id)} submitLabel={t("Submit to WhatsApp")} confirm={t("Submit this template to Meta for review?")} />}
            <ActionForm action={deleteTemplateDraftAction.bind(null, org, app, d.id)} submitLabel={t("Delete draft")} buttonClass="btn-danger" confirm={t('Delete the draft "{name}"?', { name: d.name })} />
          </div>
        )}
      </div>
      <div className="max-w-xl space-y-1 rounded-lg bg-paper-2 p-3" dir="auto">
        {d.header_text && <p className="font-medium">{d.header_text}</p>}
        <p className="whitespace-pre-wrap">{d.body}</p>
        {d.footer && <p className="text-xs text-ink-3">{d.footer}</p>}
      </div>
      {manage && d.status !== "submitted" && (
        <details>
          <summary className="cursor-pointer text-sm text-ink-2">{t("Edit")}</summary>
          <ActionForm action={saveTemplateDraftAction.bind(null, org, app, envId, d.id)} submitLabel={t("Save draft")} className="mt-3 max-w-2xl space-y-3"><DraftFields d={d} t={t} /></ActionForm>
        </details>
      )}
    </article>
  );
}
