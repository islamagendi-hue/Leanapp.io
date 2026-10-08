import Link from "next/link";
import { createDashboardAction } from "@/app/actions/dashboards";
import { ActionForm } from "@/components/ActionForm";
import { AnalyticsHeader } from "@/components/AnalyticsHeader";
import { listDashboards } from "@/modules/dashboards/service";
import { can } from "@/modules/rbac/authorize";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export const metadata = { title: "Dashboards" };

export default async function DashboardsPage(props: PageProps<"/o/[org]/apps/[app]/analytics/dashboards">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  requirePermission(ctx, "analytics.read");
  const env = await pickEnvironment(environments, sp.env);
  const dashboards = await listDashboards(ctx, a.id);
  const canWrite = can(ctx.role, "analytics.write");
  const base = `/o/${org}/apps/${app}/analytics/dashboards`;

  return (
    <div className="space-y-6">
      <AnalyticsHeader title="Dashboards" description="Reports and numbers you check together, on one page. A dashboard belongs to the project and shows the selected environment." env={env.type} />

      <section className="card overflow-x-auto p-0">
        {dashboards.length === 0 ? (
          <p className="px-5 py-4 text-sm text-ink-3">No dashboards yet.{canWrite ? " Create one below, then add saved reports to it from Saved reports." : ""}</p>
        ) : (
          <table className="table">
            <thead><tr><th className="text-start">Name</th><th className="text-start">Shared with</th><th className="text-end">Widgets</th><th className="text-start">Made by</th></tr></thead>
            <tbody>
              {dashboards.map((d) => (
                <tr key={d.id}>
                  <td>
                    <Link className="font-medium underline" href={`${base}/${d.id}?env=${env.type}`}>{d.name}</Link>
                    {d.description && <p className="text-xs text-ink-3">{d.description}</p>}
                  </td>
                  <td className="text-sm">{d.visibility === "private" ? "Only you" : "Workspace"}</td>
                  <td className="text-end tabular-nums">{d.widget_count}</td>
                  <td className="text-sm text-ink-3">{d.created_by_name ?? "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {canWrite && (
        <section className="card max-w-xl space-y-3">
          <h2 className="h2">New dashboard</h2>
          <ActionForm action={createDashboardAction.bind(null, org, app, a.id)} submitLabel="Create dashboard">
            <label className="block"><span className="label">Name</span><input name="name" className="input" required maxLength={80} /></label>
            <label className="block"><span className="label">Description (optional)</span><input name="description" className="input" maxLength={500} /></label>
            <fieldset className="space-y-1 text-sm">
              <legend className="label">Shared with</legend>
              <label className="flex items-center gap-2"><input type="radio" name="visibility" value="workspace" defaultChecked /> Everyone in the workspace who can see analytics</label>
              <label className="flex items-center gap-2"><input type="radio" name="visibility" value="private" /> Only me</label>
            </fieldset>
          </ActionForm>
        </section>
      )}
    </div>
  );
}
