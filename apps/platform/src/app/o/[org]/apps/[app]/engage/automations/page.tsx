import Link from "next/link";
import { FlowLibrary } from "@/components/engage/FlowLibrary";
import { knownEvents, plannedEvents, StatusPill } from "@/components/engage/shared";
import { getLang, getT } from "@/i18n/server";
import type { Lang } from "@/i18n/translate";
import { describeTrigger } from "@/modules/automation/definition";
import type { ChannelState } from "@/modules/automation/library";
import { listAutomations } from "@/modules/automation/service";
import { listAudiences } from "@/modules/audiences/service";
import { listIntegrations } from "@/modules/messaging/integrations";
import { can } from "@/modules/rbac/authorize";
import { listTemplates } from "@/modules/whatsapp/service";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export async function generateMetadata() {
  return { title: (await getT())("Flows") };
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function AutomationsPage(props: PageProps<"/o/[org]/apps/[app]/engage/automations">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: project, environments } = await loadApp(org, app);
  requirePermission(ctx, "automations.read");
  const env = await pickEnvironment(environments, sp.env);
  const automations = await listAutomations(ctx, env.id);
  const [audiences, events, planned, integrations, whatsappTemplates] = await Promise.all([
    can(ctx.role, "audiences.read") ? listAudiences(ctx, env.id, { includeArchived: true }) : Promise.resolve([]),
    // The library maps its events to the ones this environment receives, else to the tracking plan (unknown without the permission).
    can(ctx.role, "analytics.read") ? knownEvents(ctx, env.id) : Promise.resolve(null),
    plannedEvents(ctx, project.id),
    can(ctx.role, "integrations.read") ? listIntegrations(ctx, env.id) : Promise.resolve(null),
    listTemplates(ctx, env.id),
  ]);
  const manage = can(ctx.role, "automations.manage");
  const [t, lang] = await Promise.all([getT(), getLang()]);
  const audienceName = (id: string) => audiences.find((a) => a.id === id)?.name ?? t("an audience");
  const base = `/o/${org}/apps/${app}/engage/automations`;
  const connected = (...providers: string[]) => (integrations ? integrations.some((i) => providers.includes(i.provider) && i.status !== "disabled") : null);
  const channels: ChannelState = { push: connected("fcm", "apns"), email: connected("resend"), whatsapp: connected("whatsapp"), in_app: true };
  const copy = one(sp.copy);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="h1">{t("Flows")}</h1>
          <p className="mt-1 max-w-2xl text-ink-2">{t("Journeys that start on an event, an audience change or a schedule, with waits, conditions, branches and messages in between, and an optional conversion goal. For one message to an audience, use Campaigns.")}</p>
        </div>
        <div className="flex items-center gap-3">
          <a className="btn-secondary" href="#library">{t("Flows library")}</a>
          {manage && <Link className="btn" href={`${base}/new?env=${env.type}`}>{t("New flow")}</Link>}
        </div>
      </div>
      <section className="card">
        {automations.length === 0 ? <p className="text-sm text-ink-3">{t("No flows in the {env} environment yet.", { env: env.type })}</p> : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>{t("Name")}</th><th>{t("Status")}</th><th>{t("Trigger")}</th><th className="text-end">{t("In progress")}</th><th className="text-end">{t("Completed")}</th><th className="text-end">{t("Failed")}</th><th>{t("Version")}</th></tr></thead>
              <tbody>
                {automations.map((a) => (
                  <tr key={a.id}>
                    <td><Link className="font-medium hover:underline" href={`${base}/${a.id}`}>{a.name}</Link></td>
                    <td><StatusPill status={a.status} /></td>
                    <td className="text-xs text-ink-2">{describeTrigger(a.definition.trigger, audienceName, t)}</td>
                    <td className="text-end tabular-nums">{a.runs.active}</td>
                    <td className="text-end tabular-nums">{a.runs.completed}</td>
                    <td className="text-end tabular-nums">{a.runs.failed}</td>
                    <td className="text-ink-3">v{a.version}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <FlowLibrary
        org={org} app={app} environmentId={env.id} envType={env.type} envLabel={t(env.type)}
        known={{ seen: events ? new Set(events) : null, planned: planned ? new Set(planned) : null }}
        eventNames={[...new Set([...(events ?? []), ...(planned ?? [])])]}
        channels={channels}
        whatsappTemplates={whatsappTemplates.filter((w) => w.provider === "whatsapp_cloud" && w.status === "APPROVED" && w.header_params === 0 && (!w.header_format || w.header_format === "TEXT"))}
        canCreate={manage} canManageAudiences={can(ctx.role, "audiences.manage")}
        filters={{ q: one(sp.q), category: one(sp.category), goal: one(sp.goal) }}
        copyLang={(copy === "ar" || copy === "en" ? copy : lang) as Lang}
      />
    </div>
  );
}
