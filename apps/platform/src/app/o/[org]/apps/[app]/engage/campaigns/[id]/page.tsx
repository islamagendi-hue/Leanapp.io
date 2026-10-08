import Link from "next/link";
import { notFound } from "next/navigation";
import { campaignLifecycleAction, saveCampaignAction } from "@/app/actions/campaigns";
import { ActionForm } from "@/components/ActionForm";
import { CampaignForm } from "@/components/engage/CampaignForm";
import { fmtDate, StatusPill } from "@/components/engage/shared";
import { NotFoundError } from "@/lib/errors";
import { listAudiences } from "@/modules/audiences/service";
import { describeStep, describeTrigger } from "@/modules/automation/definition";
import { CHANNEL_LABELS, campaignOf, formOf, sendsLater } from "@/modules/campaigns/definition";
import { getCampaign } from "@/modules/campaigns/service";
import { listEmailTemplates } from "@/modules/messaging/email";
import { listIntegrations } from "@/modules/messaging/integrations";
import { UNAVAILABLE } from "@/modules/messaging/metrics";
import { getOrganization } from "@/modules/organizations/service";
import { can } from "@/modules/rbac/authorize";
import { listTemplates } from "@/modules/whatsapp/service";
import { loadApp, requirePermission } from "@/server/session";

export const metadata = { title: "Campaign" };

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

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-ink-3"><Link className="hover:underline" href={`${base}?env=${env.type}`}>Campaigns</Link> / {env.type}</p>
          <h1 className="h1">{c.name} <StatusPill status={c.campaignStatus} /></h1>
          <p className="mt-1 text-sm text-ink-2">{describeTrigger(c.definition.trigger, () => audience?.name ?? "an audience")}{c.next_fire_at && c.status === "active" ? ` · next send ${fmtDate(c.next_fire_at)}` : ""}</p>
        </div>
        {manage && c.status !== "archived" && (
          <div className="flex flex-wrap gap-2">
            {canSend && (
              <ActionForm action={campaignLifecycleAction.bind(null, org, app, c.id, "send")} className="space-y-2"
                submitLabel={c.status === "paused" ? "Resume" : sendsLater(c.definition) ? "Schedule" : c.definition.trigger.type === "once" ? "Send now" : "Start"}
                confirm={`Send to everyone in ${audience?.name ?? "the audience"}${audience ? ` (${audience.member_count.toLocaleString("en-US")} people now)` : ""}?`} />
            )}
            {c.status === "active" && <ActionForm action={campaignLifecycleAction.bind(null, org, app, c.id, "pause")} submitLabel="Pause" buttonClass="btn-secondary" className="space-y-2" />}
            <ActionForm action={campaignLifecycleAction.bind(null, org, app, c.id, "cancel")} submitLabel="Cancel campaign" buttonClass="btn-danger" className="space-y-2" confirm="Cancel this campaign? Nothing more is sent." />
          </div>
        )}
      </div>

      {notConnected && (
        <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
          {s.channel && CHANNEL_LABELS[s.channel]} isn&apos;t connected in {env.type}, so sends will be logged as failed. Connect it in <Link className="underline" href={`/o/${org}/apps/${app}/settings/dev-ops/channels?env=${env.type}`}>Channels</Link>.
        </p>
      )}
      {audience && audience.status !== "active" && c.status === "draft" && (
        <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">The audience &ldquo;{audience.name}&rdquo; is a draft. Activate it before sending.</p>
      )}

      <section className="grid gap-4 sm:grid-cols-5" aria-label="Send status">
        {([["Recipients", st.recipients], ["In progress", st.inProgress], ["Sent", st.sent], ["Failed", st.failed], ["Skipped", st.skipped]] as const).map(([label, n]) => (
          <div key={label} className="card">
            <p className="text-sm text-ink-3">{label}</p>
            <p className="text-2xl font-semibold tabular-nums">{n.toLocaleString("en-US")}</p>
          </div>
        ))}
      </section>
      {s.channel && (
        <section className="grid gap-4 sm:grid-cols-3" aria-label="Delivery">
          {(["delivered", "opened", "clicked"] as const).map((m) => {
            const n = delivery[s.channel!][m];
            const why = UNAVAILABLE[s.channel!][m];
            return (
              <div key={m} className="card">
                <p className="text-sm text-ink-3">{m[0].toUpperCase() + m.slice(1)}</p>
                {n === null ? <p className="text-sm text-ink-3" title={why ?? undefined}>Not available<span className="block text-xs">{why}</span></p>
                  : <p className="text-2xl font-semibold tabular-nums">{n.toLocaleString("en-US")}</p>}
              </div>
            );
          })}
        </section>
      )}
      <p className="text-xs text-ink-3">
        Sent means handed to the provider (push, email, WhatsApp) or queued for the app (in-app).
        Skipped covers the frequency cap, missing consent, and people with no device, email or phone number.
        See <Link className="underline" href={`/o/${org}/apps/${app}/engage/channels?env=${env.type}`}>Channels &amp; delivery</Link> for what each channel can report.
      </p>

      <section className="card space-y-2">
        <h2 className="h2">Message</h2>
        <p className="text-sm">{s.step ? describeStep(s.step) : "–"}</p>
        <p className="text-xs text-ink-3">
          Cap: {c.definition.frequencyCap ? `${c.definition.frequencyCap.messages} messages / ${c.definition.frequencyCap.hours} h` : "none"} ·
          Quiet hours: {c.definition.quietHours ? `${c.definition.quietHours.start}–${c.definition.quietHours.end} ${organization.timezone}` : "none"}
        </p>
      </section>

      {runs.length > 0 && (
        <section className="card space-y-2">
          <h2 className="h2">Latest recipients</h2>
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>Person</th><th>Status</th><th>Result</th><th>When</th></tr></thead>
              <tbody>
                {runs.map((r) => {
                  const last = [...r.log].reverse().find((l) => l.step === 0);
                  return (
                    <tr key={r.id}>
                      <td className="font-mono text-xs break-all">{r.user_key}</td>
                      <td><StatusPill status={r.status} /></td>
                      <td className={`text-xs ${last?.outcome === "failed" ? "text-alert" : last?.outcome === "skipped" ? "text-warn" : ""}`}>{last ? `${last.outcome}${last.detail ? `: ${last.detail}` : ""}` : "–"}</td>
                      <td className="text-ink-3">{fmtDate(r.finished_at ?? r.started_at)}</td>
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
          <h2 className="h2">Edit</h2>
          <CampaignForm action={saveCampaignAction.bind(null, org, app, env.id, c.id)} name={c.name} initial={formOf(c.definition, organization.timezone)} submitLabel="Save"
            audiences={audiences.filter((a) => a.status !== "archived")} emailTemplates={emailTemplates} whatsappTemplates={whatsappTemplates.filter((t) => t.header_params === 0)} timezone={organization.timezone} />
        </section>
      )}
    </div>
  );
}
