import Link from "next/link";
import { notFound } from "next/navigation";
import { deleteCohortAction, updateCohortAction } from "@/app/actions/analytics";
import { ActionForm } from "@/components/ActionForm";
import { AnalyticsHeader } from "@/components/AnalyticsHeader";
import { CohortForm } from "@/components/CohortForm";
import { NotFoundError } from "@/lib/errors";
import { describeCohort } from "@/modules/analytics/cohort-form";
import { cohortMembers, getCohort, type Cohort } from "@/modules/analytics/cohorts";
import { topEvents } from "@/modules/analytics/service";
import { PROPERTY_OP_LABELS } from "@/modules/analytics/sql";
import { can } from "@/modules/rbac/authorize";
import { catalogForPickers, options } from "@/modules/properties/catalog";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export const metadata = { title: "Cohort" };

export default async function CohortPage(props: PageProps<"/o/[org]/apps/[app]/analytics/cohorts/[cohort]">) {
  const { org, app, cohort: id } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  requirePermission(ctx, "analytics.read");
  const env = await pickEnvironment(environments, sp.env);
  let c: Cohort;
  try {
    c = await getCohort(ctx, env.id, id);
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
  const canProfiles = can(ctx.role, "users.read");
  const members = await cohortMembers(ctx, { environmentId: env.id, timezone: a.timezone }, c.id, { limit: canProfiles ? 50 : 0 });
  const canWrite = can(ctx.role, "analytics.write");
  const events = canWrite ? (await topEvents(ctx, { environmentId: env.id, days: 90 })).map((e) => e.name) : [];
  const catalog = canWrite ? await catalogForPickers(ctx, { appId: a.id, environmentId: env.id }, "analytics.read") : null;
  const properties = catalog ? { user: options(catalog.user).map((o) => o.name), event: options(catalog.event).map((o) => o.name) } : undefined;
  const base = `/o/${org}/apps/${app}/analytics`;
  const withCohort = (page: string) => `${base}/${page}?env=${env.type}&cohort=${c.id}`;
  const when = (d: Date | null) => (d ? new Date(d).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: a.timezone }) : "–");
  const profile = (person: string) => `${base}/users/profile?${new URLSearchParams({ env: env.type, ...(person.startsWith("anon:") ? { anon: person.slice(5) } : { user: person }) })}`;

  return (
    <div className="space-y-6">
      <AnalyticsHeader title={c.name} description={describeCohort(c.definition, PROPERTY_OP_LABELS)} env={env.type} />
      <p className="text-sm"><Link className="underline" href={`${base}/cohorts?env=${env.type}`}>← All cohorts</Link></p>

      <section className="card flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-3xl font-bold tabular-nums">{members.size.toLocaleString("en-US")}</p>
          <p className="text-sm text-ink-3">people right now</p>
        </div>
        <div className="flex flex-wrap gap-2 text-sm">
          <Link className="btn-secondary" href={withCohort("events")}>Events</Link>
          <Link className="btn-secondary" href={withCohort("funnels")}>Funnels</Link>
          <Link className="btn-secondary" href={withCohort("retention")}>Retention</Link>
          <Link className="btn-secondary" href={withCohort("revenue")}>Revenue</Link>
        </div>
      </section>

      {canProfiles && members.sample.length > 0 && (
        <section className="card overflow-x-auto p-0">
          <h2 className="h2 px-5 pt-4">Members{members.size > members.sample.length ? ` (${members.sample.length} most recently seen)` : ""}</h2>
          <table className="table">
            <thead><tr><th className="text-start">Person</th><th className="text-start">Last seen</th></tr></thead>
            <tbody>
              {members.sample.map((m) => (
                <tr key={m.person}>
                  <td className="font-mono text-sm"><Link className="underline" href={profile(m.person)}>{m.person}</Link></td>
                  <td className="whitespace-nowrap">{when(m.lastSeen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {canWrite && (
        <>
          <section className="card space-y-3">
            <h2 className="h2">Edit</h2>
            <CohortForm
              action={updateCohortAction.bind(null, org, app, env.id, c.id)}
              events={events} properties={properties} submitLabel="Save cohort" name={c.name} description={c.description} definition={c.definition}
            />
          </section>
          <section className="card flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-ink-2">Deleting a cohort removes it from saved reports that filter by it; they show everyone instead.</p>
            <ActionForm action={deleteCohortAction.bind(null, org, app, env.id, c.id, env.type)} submitLabel="Delete cohort" buttonClass="btn-danger" className="" confirm={`Delete the cohort "${c.name}"?`} />
          </section>
        </>
      )}
      {c.created_by_name && <p className="text-xs text-ink-3">Created by {c.created_by_name} on {when(c.created_at)}.</p>}
    </div>
  );
}
