import Link from "next/link";
import { deleteReportAction } from "@/app/actions/analytics";
import { ActionForm } from "@/components/ActionForm";
import { AnalyticsHeader, RANGE_LABELS } from "@/components/AnalyticsHeader";
import { paramsFromConfig, REPORT_PAGES } from "@/modules/analytics/report-params";
import { listSavedReports } from "@/modules/analytics/saved-reports";
import { can } from "@/modules/rbac/authorize";
import { audienceOptions } from "@/server/analytics-page";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export const metadata = { title: "Saved reports" };

function summary(kind: string, config: Record<string, unknown>, cohorts: Map<string, string>): string {
  const parts: string[] = [];
  if (kind === "trend") parts.push(String(config.event));
  if (kind === "funnel" && Array.isArray(config.steps)) parts.push(config.steps.join(" → "));
  if (kind === "retention") parts.push(`${config.startEvent} → ${config.returnEvent}`);
  if (typeof config.breakdown === "string") parts.push(`by ${config.breakdown.replace(/^property:/, "")}`);
  parts.push(RANGE_LABELS[Number(config.days)]?.toLowerCase() ?? "");
  if (typeof config.cohortId === "string") parts.push(`audience: ${cohorts.get(config.cohortId) ?? "archived or deleted"}`);
  return parts.filter(Boolean).join(" · ");
}

export default async function AnalyticsOverview(props: PageProps<"/o/[org]/apps/[app]/analytics">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, environments } = await loadApp(org, app);
  requirePermission(ctx, "analytics.read");
  const env = await pickEnvironment(environments, sp.env);
  const [reports, cohorts] = await Promise.all([listSavedReports(ctx, env.id), audienceOptions(ctx, env.id)]);
  const cohortNames = new Map(cohorts.map((c) => [c.id, c.name]));
  const canWrite = can(ctx.role, "analytics.write");
  const base = `/o/${org}/apps/${app}/analytics`;
  const open = (kind: keyof typeof REPORT_PAGES, config: Record<string, unknown>) => {
    const q = paramsFromConfig(kind, config);
    q.set("env", env.type);
    return `${base}/${REPORT_PAGES[kind].path}?${q}`;
  };
  const reportLinks = [
    { href: "events", label: "Events", text: "Counts and people per day, split by any dimension." },
    { href: "funnels", label: "Funnels", text: "Conversion through ordered steps." },
    { href: "retention", label: "Retention", text: "Who comes back after day 1, 3, 7, 14, 30." },
    { href: "revenue", label: "Revenue", text: "Net revenue per currency, ARPU and paying people." },
    ...(can(ctx.role, "users.read") ? [{ href: "users", label: "Users", text: "One person's profile and full timeline." }] : []),
  ];

  return (
    <div className="space-y-6">
      <AnalyticsHeader title="Saved reports" description="Saved reports for this environment, and every report." env={env.type} />

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {reportLinks.map((l) => (
          <Link key={l.href} href={`${base}/${l.href}?env=${env.type}`} className="card block hover:border-line-strong">
            <p className="font-medium">{l.label}</p>
            <p className="mt-1 text-sm text-ink-3">{l.text}</p>
          </Link>
        ))}
      </section>

      <section className="card overflow-x-auto p-0">
        <h2 className="h2 px-5 pt-4">Saved reports</h2>
        {reports.length === 0 ? (
          <p className="px-5 py-4 text-sm text-ink-3">
            None yet. {canWrite ? "Open a report, set it up, and use “Save this report” below it." : "People with permission to save reports can add them from any report."}
          </p>
        ) : (
          <table className="table">
            <thead><tr><th className="text-start">Name</th><th className="text-start">Type</th><th className="text-start">Settings</th><th className="text-start">Saved by</th>{canWrite && <th />}</tr></thead>
            <tbody>
              {reports.map((r) => (
                <tr key={r.id}>
                  <td><Link className="font-medium underline" href={open(r.kind, r.config)}>{r.name}</Link></td>
                  <td>{REPORT_PAGES[r.kind].label}</td>
                  <td className="text-sm text-ink-2">{summary(r.kind, r.config, cohortNames)}</td>
                  <td className="text-sm text-ink-3">{r.created_by_name ?? "–"}</td>
                  {canWrite && (
                    <td className="text-end">
                      <ActionForm action={deleteReportAction.bind(null, org, app, env.id, r.id)} submitLabel="Delete" buttonClass="btn-danger" className="" confirm={`Delete the saved report "${r.name}"?`} />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card space-y-1">
        <h2 className="h2">Audiences</h2>
        <p className="text-sm text-ink-2">
          Cohorts are now audiences: one place to define a group of people, used to filter every report, the Users list and Engagement.
          Pick one with &ldquo;People in audience&rdquo; on any report.
        </p>
        {can(ctx.role, "audiences.read") && (
          <p className="text-sm"><Link className="underline" href={`/o/${org}/apps/${app}/engage/audiences?env=${env.type}`}>{cohorts.length ? `Open audiences (${cohorts.length})` : "Open audiences"}</Link></p>
        )}
      </section>
    </div>
  );
}
