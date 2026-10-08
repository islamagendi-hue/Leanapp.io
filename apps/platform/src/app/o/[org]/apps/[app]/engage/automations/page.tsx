import Link from "next/link";
import { StatusPill } from "@/components/engage/shared";
import { describeTrigger } from "@/modules/automation/definition";
import { listAutomations } from "@/modules/automation/service";
import { listAudiences } from "@/modules/audiences/service";
import { can } from "@/modules/rbac/authorize";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export const metadata = { title: "Flows" };

export default async function AutomationsPage(props: PageProps<"/o/[org]/apps/[app]/engage/automations">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, environments } = await loadApp(org, app);
  requirePermission(ctx, "automations.read");
  const env = await pickEnvironment(environments, sp.env);
  const automations = await listAutomations(ctx, env.id);
  const audiences = can(ctx.role, "audiences.read") ? await listAudiences(ctx, env.id, { includeArchived: true }) : [];
  const audienceName = (id: string) => audiences.find((a) => a.id === id)?.name ?? "an audience";
  const base = `/o/${org}/apps/${app}/engage/automations`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="h1">Flows</h1>
          <p className="mt-1 max-w-2xl text-ink-2">Journeys that start on an event, an audience change or a schedule, with waits, conditions, branches and messages in between, and an optional conversion goal. For one message to an audience, use Campaigns.</p>
        </div>
        <div className="flex items-center gap-3">
          {can(ctx.role, "automations.manage") && <Link className="btn" href={`${base}/new?env=${env.type}`}>New flow</Link>}
        </div>
      </div>
      <section className="card">
        {automations.length === 0 ? <p className="text-sm text-ink-3">No flows in the {env.type} environment yet.</p> : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>Name</th><th>Status</th><th>Trigger</th><th className="text-end">In progress</th><th className="text-end">Completed</th><th className="text-end">Failed</th><th>Version</th></tr></thead>
              <tbody>
                {automations.map((a) => (
                  <tr key={a.id}>
                    <td><Link className="font-medium hover:underline" href={`${base}/${a.id}`}>{a.name}</Link></td>
                    <td><StatusPill status={a.status} /></td>
                    <td className="text-xs text-ink-2">{describeTrigger(a.definition.trigger, audienceName)}</td>
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
    </div>
  );
}
