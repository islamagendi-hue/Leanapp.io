import Link from "next/link";
import { deleteReportAction } from "@/app/actions/analytics";
import { addWidgetAction } from "@/app/actions/dashboards";
import { ActionForm } from "@/components/ActionForm";
import { AnalyticsHeader, RANGE_LABELS } from "@/components/AnalyticsHeader";
import { getT } from "@/i18n/server";
import { msg, type T } from "@/i18n/translate";
import { paramsFromConfig, REPORT_PAGES } from "@/modules/analytics/report-params";
import { listSavedReports } from "@/modules/analytics/saved-reports";
import { listDashboards } from "@/modules/dashboards/service";
import { can } from "@/modules/rbac/authorize";
import { audienceOptions } from "@/server/analytics-page";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export async function generateMetadata() {
  return { title: (await getT())("Saved reports") };
}

function summary(kind: string, config: Record<string, unknown>, cohorts: Map<string, string>, t: T): string {
  const parts: string[] = [];
  if (kind === "trend") parts.push(String(config.event));
  if (kind === "funnel" && Array.isArray(config.steps)) parts.push(config.steps.join(" → "));
  if (kind === "retention") parts.push(`${config.startEvent} → ${config.returnEvent}`);
  if (typeof config.breakdown === "string") parts.push(t("by {property}", { property: config.breakdown.replace(/^property:/, "") }));
  const days = Number(config.days);
  parts.push(RANGE_LABELS[days] ? t("Last {n} days", { n: days }).toLowerCase() : "");
  if (typeof config.cohortId === "string") parts.push(t("audience: {name}", { name: cohorts.get(config.cohortId) ?? t("archived or deleted") }));
  return parts.filter(Boolean).join(" · ");
}

export default async function AnalyticsOverview(props: PageProps<"/o/[org]/apps/[app]/analytics">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  requirePermission(ctx, "analytics.read");
  const env = await pickEnvironment(environments, sp.env);
  const [reports, cohorts] = await Promise.all([listSavedReports(ctx, env.id), audienceOptions(ctx, env.id)]);
  const cohortNames = new Map(cohorts.map((c) => [c.id, c.name]));
  const canWrite = can(ctx.role, "analytics.write");
  const dashboards = canWrite ? (await listDashboards(ctx, a.id)).filter((d) => d.visibility === "workspace" || d.created_by === ctx.userId) : [];
  const addWidget = addWidgetAction.bind(null, org, app);
  const t = await getT();
  const base = `/o/${org}/apps/${app}/analytics`;
  const open = (kind: keyof typeof REPORT_PAGES, config: Record<string, unknown>) => {
    const q = paramsFromConfig(kind, config);
    q.set("env", env.type);
    return `${base}/${REPORT_PAGES[kind].path}?${q}`;
  };
  const reportLinks = [
    { href: "events", label: msg("Events"), text: msg("Counts and people per day, split by any dimension.") },
    { href: "funnels", label: msg("Funnels"), text: msg("Conversion through ordered steps.") },
    { href: "retention", label: msg("Retention"), text: msg("Who comes back after day 1, 3, 7, 14, 30.") },
    { href: "revenue", label: msg("Revenue"), text: msg("Net revenue per currency, ARPU and paying people.") },
    { href: "dashboards", label: msg("Dashboards"), text: msg("Saved reports and numbers you check together, on one page.") },
    ...(can(ctx.role, "users.read") ? [{ href: "users", label: msg("Users"), text: msg("One person's profile and full timeline.") }] : []),
  ];

  return (
    <div className="space-y-6">
      <AnalyticsHeader title={t("Saved reports")} description={t("Saved reports for this environment, and every report.")} env={env.type} />

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {reportLinks.map((l) => (
          <Link key={l.href} href={`${base}/${l.href}?env=${env.type}`} className="card block hover:border-line-strong">
            <p className="font-medium">{t(l.label)}</p>
            <p className="mt-1 text-sm text-ink-3">{t(l.text)}</p>
          </Link>
        ))}
      </section>

      <section className="card overflow-x-auto p-0">
        <h2 className="h2 px-5 pt-4">{t("Saved reports")}</h2>
        {reports.length === 0 ? (
          <p className="px-5 py-4 text-sm text-ink-3">
            {canWrite ? t("None yet. Open a report, set it up, and use “Save this report” below it.") : t("None yet. People with permission to save reports can add them from any report.")}
          </p>
        ) : (
          <table className="table">
            <thead><tr><th className="text-start">{t("Name")}</th><th className="text-start">{t("Type")}</th><th className="text-start">{t("Settings")}</th><th className="text-start">{t("Saved by")}</th>{canWrite && <th />}</tr></thead>
            <tbody>
              {reports.map((r) => (
                <tr key={r.id}>
                  <td><Link className="font-medium underline" href={open(r.kind, r.config)}>{r.name}</Link></td>
                  <td>{t(REPORT_PAGES[r.kind].label)}</td>
                  <td className="text-sm text-ink-2">{summary(r.kind, r.config, cohortNames, t)}</td>
                  <td className="text-sm text-ink-3">{r.created_by_name ?? "–"}</td>
                  {canWrite && (
                    <td className="space-y-2 text-end">
                      {dashboards.length > 0 && (
                        <ActionForm action={addWidget} submitLabel={t("Add to dashboard")} className="flex flex-wrap items-center justify-end gap-2" buttonClass="btn-secondary min-h-8 text-xs">
                          <input type="hidden" name="type" value={r.kind} />
                          <input type="hidden" name="savedReport" value={r.id} />
                          <input type="hidden" name="w" value={r.kind === "trend" || r.kind === "revenue" ? "12" : "6"} />
                          <input type="hidden" name="h" value={r.kind === "trend" ? "3" : "2"} />
                          <select name="dashboard" className="input w-auto text-xs" aria-label={t("Dashboard for {name}", { name: r.name })}>
                            {dashboards.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                          </select>
                        </ActionForm>
                      )}
                      <ActionForm action={deleteReportAction.bind(null, org, app, env.id, r.id)} submitLabel={t("Delete")} buttonClass="btn-danger" className="" confirm={t('Delete the saved report "{name}"?', { name: r.name })} />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card space-y-1">
        <h2 className="h2">{t("Audiences")}</h2>
        <p className="text-sm text-ink-2">
          {t("Cohorts are now audiences: one place to define a group of people, used to filter every report, the Users list and Engagement.")}{" "}
          {t("Pick one with “People in audience” on any report.")}
        </p>
        {can(ctx.role, "audiences.read") && (
          <p className="text-sm"><Link className="underline" href={`/o/${org}/apps/${app}/engage/audiences?env=${env.type}`}>{cohorts.length ? t("Open audiences ({n})", { n: cohorts.length }) : t("Open audiences")}</Link></p>
        )}
      </section>
    </div>
  );
}
