import Link from "next/link";
import { createCohortAction } from "@/app/actions/analytics";
import { AnalyticsHeader } from "@/components/AnalyticsHeader";
import { CohortForm } from "@/components/CohortForm";
import { describeCohort } from "@/modules/analytics/cohort-form";
import { cohortMembers, listCohorts } from "@/modules/analytics/cohorts";
import { topEvents } from "@/modules/analytics/service";
import { PROPERTY_OP_LABELS } from "@/modules/analytics/sql";
import { log } from "@/lib/log";
import { can } from "@/modules/rbac/authorize";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export const metadata = { title: "Cohorts" };

export default async function CohortsPage(props: PageProps<"/o/[org]/apps/[app]/analytics/cohorts">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  requirePermission(ctx, "analytics.read");
  const env = await pickEnvironment(environments, sp.env);
  const cohorts = await listCohorts(ctx, env.id);
  // Sizes are computed now, each in its own bounded query; one that times out doesn't break the page.
  const sizes = await Promise.all(
    cohorts.map((c) =>
      cohortMembers(ctx, { environmentId: env.id, timezone: a.timezone }, c.id).then(
        (m) => m.size,
        (e) => {
          log.warn("analytics.cohort_size_failed", { cohortId: c.id, error: e });
          return null;
        },
      ),
    ),
  );
  const canWrite = can(ctx.role, "analytics.write");
  const events = canWrite ? (await topEvents(ctx, { environmentId: env.id, days: 90 })).map((e) => e.name) : [];
  const path = `/o/${org}/apps/${app}/analytics/cohorts`;

  return (
    <div className="space-y-6">
      <AnalyticsHeader title="Cohorts" description="Saved groups of people, by what they did and who they are. Use them to filter events, funnels, retention and revenue." env={env.type} />

      <section className="card overflow-x-auto p-0">
        {cohorts.length === 0 ? (
          <p className="px-5 py-4 text-sm text-ink-3">No cohorts in this environment yet.</p>
        ) : (
          <table className="table">
            <thead><tr><th className="text-start">Cohort</th><th className="text-start">Definition</th><th className="text-end">People now</th></tr></thead>
            <tbody>
              {cohorts.map((c, i) => (
                <tr key={c.id}>
                  <td><Link className="font-medium underline" href={`${path}/${c.id}?env=${env.type}`}>{c.name}</Link>{c.description && <div className="text-xs text-ink-3">{c.description}</div>}</td>
                  <td className="text-sm text-ink-2">{describeCohort(c.definition, PROPERTY_OP_LABELS)}</td>
                  <td className="text-end tabular-nums">{sizes[i] === null ? <span className="text-ink-3" title="Took too long to compute">–</span> : sizes[i]!.toLocaleString("en-US")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {canWrite && (
        <section className="card space-y-3">
          <h2 className="h2">New cohort</h2>
          <CohortForm action={createCohortAction.bind(null, org, app, env.id, env.type)} events={events} submitLabel="Create cohort" />
        </section>
      )}
      <p className="text-xs text-ink-3">
        Cohorts belong to one environment and are computed from current data whenever they&apos;re used. A person is a user ID with the anonymous activity of installs linked only to them; shared devices are never merged.
        Date ranges are calendar days in the app&apos;s timezone ({a.timezone}).
      </p>
    </div>
  );
}
