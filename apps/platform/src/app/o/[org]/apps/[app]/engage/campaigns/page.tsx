import Link from "next/link";
import { fmtDate, StatusPill } from "@/components/engage/shared";
import { listAudiences } from "@/modules/audiences/service";
import { CHANNEL_LABELS, campaignOf } from "@/modules/campaigns/definition";
import { listCampaigns } from "@/modules/campaigns/service";
import { can } from "@/modules/rbac/authorize";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export const metadata = { title: "Campaigns" };

export default async function CampaignsPage(props: PageProps<"/o/[org]/apps/[app]/engage/campaigns">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, environments } = await loadApp(org, app);
  requirePermission(ctx, "automations.read");
  const env = await pickEnvironment(environments, sp.env);
  const [campaigns, audiences] = await Promise.all([
    listCampaigns(ctx, env.id),
    can(ctx.role, "audiences.read") ? listAudiences(ctx, env.id, { includeArchived: true }) : Promise.resolve([]),
  ]);
  const audienceName = (id: string | null) => audiences.find((a) => a.id === id)?.name ?? "an audience";
  const base = `/o/${org}/apps/${app}/engage/campaigns`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="h1">Campaigns</h1>
          <p className="mt-1 max-w-2xl text-ink-2">One message to an audience, now, at a set time or on a schedule, by push, in-app, email or WhatsApp. For multi-step journeys, use Flows.</p>
        </div>
        {can(ctx.role, "automations.manage") && <Link className="btn" href={`${base}/new?env=${env.type}`}>New campaign</Link>}
      </div>
      <section className="card">
        {campaigns.length === 0 ? <p className="text-sm text-ink-3">No campaigns in the {env.type} environment yet.</p> : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>Name</th><th>Status</th><th>Audience</th><th>Channel</th><th>Send</th><th className="text-end">Recipients</th><th className="text-end">Sent</th><th className="text-end">Failed</th><th className="text-end">Skipped</th></tr></thead>
              <tbody>
                {campaigns.map((c) => {
                  const s = campaignOf(c.definition);
                  return (
                    <tr key={c.id}>
                      <td><Link className="font-medium hover:underline" href={`${base}/${c.id}`}>{c.name}</Link></td>
                      <td><StatusPill status={c.campaignStatus} /></td>
                      <td className="text-sm">{audienceName(s.audienceId)}</td>
                      <td className="text-sm">{s.channel ? CHANNEL_LABELS[s.channel] : "–"}</td>
                      <td className="text-xs text-ink-2">{s.schedule?.mode === "once" ? fmtDate(s.schedule.at) : s.schedule ? `${s.schedule.mode} at ${s.schedule.at}` : "–"}</td>
                      <td className="text-end tabular-nums">{c.stats.recipients}</td>
                      <td className="text-end tabular-nums">{c.stats.sent}</td>
                      <td className="text-end tabular-nums">{c.stats.failed}</td>
                      <td className="text-end tabular-nums">{c.stats.skipped}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
