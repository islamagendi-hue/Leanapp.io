import Link from "next/link";
import { fmtDate, StatusPill } from "@/components/engage/shared";
import { describeNode } from "@/modules/audiences/definition";
import { listAudiences } from "@/modules/audiences/service";
import { can } from "@/modules/rbac/authorize";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export const metadata = { title: "Audiences" };

export default async function AudiencesPage(props: PageProps<"/o/[org]/apps/[app]/engage/audiences">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, environments } = await loadApp(org, app);
  requirePermission(ctx, "audiences.read");
  const env = await pickEnvironment(environments, sp.env);
  const audiences = await listAudiences(ctx, env.id, { includeArchived: sp.archived === "1" });
  const base = `/o/${org}/apps/${app}/engage/audiences`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="h1">Audiences</h1>
          <p className="mt-1 max-w-2xl text-ink-2">Groups of people defined by what they did, who they are and how they use your app. Active audiences are recomputed on a schedule and can start automations when people enter or leave.</p>
        </div>
        <div className="flex items-center gap-3">
          {can(ctx.role, "audiences.manage") && <Link className="btn" href={`${base}/new?env=${env.type}`}>New audience</Link>}
        </div>
      </div>
      <section className="card">
        {audiences.length === 0 ? (
          <p className="text-sm text-ink-3">No audiences in the {env.type} environment yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>Name</th><th>Status</th><th>Definition</th><th className="text-end">People</th><th>Computed</th></tr></thead>
              <tbody>
                {audiences.map((a) => (
                  <tr key={a.id}>
                    <td><Link className="font-medium hover:underline" href={`${base}/${a.id}`}>{a.name}</Link></td>
                    <td><StatusPill status={a.status} /></td>
                    <td className="max-w-md text-xs text-ink-2">{describeNode(a.definition)}</td>
                    <td className="text-end tabular-nums">{a.status === "draft" ? "–" : a.member_count.toLocaleString("en-US")}</td>
                    <td className="text-ink-3">{a.last_compute_error ? <span className="text-alert">{a.last_compute_error}</span> : fmtDate(a.last_computed_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-ink-3"><Link className="hover:underline" href={`${base}?env=${env.type}&archived=${sp.archived === "1" ? "0" : "1"}`}>{sp.archived === "1" ? "Hide" : "Show"} archived</Link></p>
      </section>
    </div>
  );
}
