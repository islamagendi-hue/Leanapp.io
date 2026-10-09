import Link from "next/link";
import { notFound } from "next/navigation";
import { campaignLifecycleAction, saveCampaignAction } from "@/app/actions/campaigns";
import { ActionForm } from "@/components/ActionForm";
import { CampaignForm } from "@/components/engage/CampaignForm";
import { fmtDate, StatusPill } from "@/components/engage/shared";
import { getLang, getT } from "@/i18n/server";
import { msg } from "@/i18n/translate";
import { NotFoundError } from "@/lib/errors";
import { listAudiences } from "@/modules/audiences/service";
import { describeStep, describeTrigger } from "@/modules/automation/definition";
import { translateMessage } from "@/modules/automation/messages";
import { OUTCOME_TEXT } from "@/modules/automation/run-log";
import { CHANNEL_LABELS, campaignOf, formOf, sendsLater } from "@/modules/campaigns/definition";
import { getCampaign } from "@/modules/campaigns/service";
import { listEmailTemplates } from "@/modules/messaging/email";
import { listIntegrations } from "@/modules/messaging/integrations";
import { UNAVAILABLE } from "@/modules/messaging/metrics";
import { getOrganization } from "@/modules/organizations/service";
import { can } from "@/modules/rbac/authorize";
import { listTemplates } from "@/modules/whatsapp/service";
import { loadApp, requirePermission } from "@/server/session";

export async function generateMetadata() {
  return { title: (await getT())("Campaign") };
}

const METRIC_TEXT: Record<string, string> = { delivered: msg("Delivered"), opened: msg("Opened"), clicked: msg("Clicked") };
const PROVIDERS: Record<string, string[]> = { push: ["fcm", "apns"], email: ["resend"], whatsapp: ["whatsapp"], in_app: [] };

export default async function CampaignPage(props: PageProps<"/o/[org]/apps/[app]/engage/campaigns/[id]">) {
  const { org, app, id } = await props.params;
  const { ctx, environments } = await loadApp(org, app);
  requirePermission(ctx, "automations.read");
  const { campaign: c, runs, delivery } = await getCampaign(ctx, id).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  const env = environments.find((e) => e.id === c.environment_id);
  if (!env) notFound();
  const manage = can(ctx.role, "automations.manage");
  const editable = manage && !c.fired && c.status !== "archived";
  const [audiences, organization, integrations, whatsappTemplates, emailTemplates] = await Promise.all([
    can(ctx.role, "audiences.read") ? listAudiences(ctx, env.id, { includeArchived: true }) : Promise.resolve([]),
    getOrganization(ctx),
    can(ctx.role, "integrations.read") ? listIntegrations(ctx, env.id) : Promise.resolve(null),
    editable ? listTemplates(ctx, env.id) : Promise.resolve([]),
    editable ? listEmailTemplates(ctx, env.id) : Promise.resolve([]),
  ]);
  const s = campaignOf(c.definition);
  const audience = audiences.find((a) => a.id === s.audienceId);
  const providers = s.channel ? PROVIDERS[s.channel] : [];
  const notConnected = integrations !== null && providers.length > 0 && !integrations.some((i) => providers.includes(i.provider));
  const base = `/o/${org}/apps/${app}/engage/campaigns`;
  const canSend = manage && (c.status === "draft" || c.status === "paused") && !(c.fired && c.definition.trigger.type === "once");
  const st = c.stats;
  const [t, lang] = await Promise.all([getT(), getLang()]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-ink-3"><Link className="hover:underline" href={`${base}?env=${env.type}`}>{t("Campaigns")}</Link> / {t(env.type)}</p>
          <h1 className="h1">{c.name} <StatusPill status={c.campaignStatus} /></h1>
          <p className="mt-1 text-sm text-ink-2">{describeTrigger(c.definition.trigger, () => audience?.name ?? t("an audience"), t)}{c.next_fire_at && c.status === "active" ? ` · ${t("next send {date}", { date: fmtDate(c.next_fire_at, lang) })}` : ""}</p>
        </div>
        {manage && c.status !== "archived" && (
          <div className="flex flex-wrap gap-2">
            {canSend && (
              <ActionForm action={campaignLifecycleAction.bind(null, org, app, c.id, "send")} className="space-y-2"
                submitLabel={c.status === "paused" ? t("Resume") : sendsLater(c.definition) ? t("Schedule") : c.definition.trigger.type === "once" ? t("Send now") : t("Start")}
                confirm={audience ? t("Send to everyone in {name} ({n} people now)?", { name: audience.name, n: audience.member_count.toLocaleString("en-US") }) : t("Send to everyone in the audience?")} />
            )}
            {c.status === "active" && <ActionForm action={campaignLifecycleAction.bind(null, org, app, c.id, "pause")} submitLabel={t("Pause")} buttonClass="btn-secondary" className="space-y-2" />}
            <ActionForm action={campaignLifecycleAction.bind(null, org, app, c.id, "cancel")} submitLabel={t("Cancel campaign")} buttonClass="btn-danger" className="space-y-2" confirm={t("Cancel this campaign? Nothing more is sent.")} />
          </div>
        )}
      </div>

      {notConnected && (
        <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
          {t("{channel} isn't connected in {env}, so sends will be logged as failed. Connect it in", { channel: s.channel ? t(CHANNEL_LABELS[s.channel]) : "", env: t(env.type) })} <Link className="underline" href={`/o/${org}/apps/${app}/settings/dev-ops/channels?env=${env.type}`}>{t("Channels")}</Link>.
        </p>
      )}
      {audience && audience.status !== "active" && c.status === "draft" && (
        <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">{t("The audience “{name}” is a draft. Activate it before sending.", { name: audience.name })}</p>
      )}

      <section className="grid gap-4 sm:grid-cols-5" aria-label={t("Send status")}>
        {([[msg("Recipients"), st.recipients], [msg("In progress"), st.inProgress], [msg("Sent"), st.sent], [msg("Failed"), st.failed], [msg("Skipped"), st.skipped]] as const).map(([label, n]) => (
          <div key={label} className="card">
            <p className="text-sm text-ink-3">{t(label)}</p>
            <p className="text-2xl font-semibold tabular-nums">{n.toLocaleString("en-US")}</p>
          </div>
        ))}
      </section>
      {s.channel && (
        <section className="grid gap-4 sm:grid-cols-3" aria-label={t("Delivery")}>
          {(["delivered", "opened", "clicked"] as const).map((m) => {
            const n = delivery[s.channel!][m];
            const why = UNAVAILABLE[s.channel!][m];
            return (
              <div key={m} className="card">
                <p className="text-sm text-ink-3">{t(METRIC_TEXT[m])}</p>
                {n === null ? <p className="text-sm text-ink-3" title={why ? t(why) : undefined}>{t("Not available")}<span className="block text-xs">{why && t(why)}</span></p>
                  : <p className="text-2xl font-semibold tabular-nums">{n.toLocaleString("en-US")}</p>}
              </div>
            );
          })}
        </section>
      )}
      <p className="text-xs text-ink-3">
        {t("Sent means handed to the provider (push, email, WhatsApp) or queued for the app (in-app).")}{" "}
        {t("Skipped covers the frequency cap, missing consent, and people with no device, email or phone number.")}{" "}
        {t("See")} <Link className="underline" href={`/o/${org}/apps/${app}/engage/channels?env=${env.type}`}>{t("Channels & delivery")}</Link> {t("for what each channel can report.")}
      </p>

      <section className="card space-y-2">
        <h2 className="h2">{t("Message")}</h2>
        <p className="text-sm">{s.step ? describeStep(s.step, t) : "–"}</p>
        <p className="text-xs text-ink-3">
          {t("Cap:")} {c.definition.frequencyCap ? t("{n} messages / {hours} h", { n: c.definition.frequencyCap.messages, hours: c.definition.frequencyCap.hours }) : t("none")} ·
          {t("Quiet hours:")} {c.definition.quietHours ? <span dir="ltr">{`${c.definition.quietHours.start}–${c.definition.quietHours.end} ${organization.timezone}`}</span> : t("none")}
        </p>
      </section>

      {runs.length > 0 && (
        <section className="card space-y-2">
          <h2 className="h2">{t("Latest recipients")}</h2>
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>{t("Person")}</th><th>{t("Status")}</th><th>{t("Result")}</th><th>{t("When")}</th></tr></thead>
              <tbody>
                {runs.map((r) => {
                  const last = [...r.log].reverse().find((l) => l.step === 0);
                  return (
                    <tr key={r.id}>
                      <td className="font-mono text-xs break-all">{r.user_key}</td>
                      <td><StatusPill status={r.status} /></td>
                      <td className={`text-xs ${last?.outcome === "failed" ? "text-alert" : last?.outcome === "skipped" ? "text-warn" : ""}`}>{last ? `${OUTCOME_TEXT[last.outcome] ? t(OUTCOME_TEXT[last.outcome]) : last.outcome}${last.detail ? `: ${translateMessage(t, last.detail)}` : ""}` : "–"}</td>
                      <td className="text-ink-3">{fmtDate(r.finished_at ?? r.started_at, lang)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {editable && (
        <section className="card space-y-3">
          <h2 className="h2">{t("Edit")}</h2>
          <CampaignForm action={saveCampaignAction.bind(null, org, app, env.id, c.id)} name={c.name} initial={formOf(c.definition, organization.timezone)} submitLabel={t("Save")}
            audiences={audiences.filter((a) => a.status !== "archived")} emailTemplates={emailTemplates} whatsappTemplates={whatsappTemplates.filter((w) => w.header_params === 0)} timezone={organization.timezone} />
        </section>
      )}
    </div>
  );
}
