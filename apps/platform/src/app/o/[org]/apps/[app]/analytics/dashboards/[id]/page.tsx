import Link from "next/link";
import { notFound } from "next/navigation";
import { deleteDashboardAction, moveWidgetAction, removeWidgetAction, updateDashboardAction } from "@/app/actions/dashboards";
import { ActionForm } from "@/components/ActionForm";
import { param } from "@/components/AnalyticsHeader";
import { AddWidgetForm } from "@/components/dashboards/AddWidgetForm";
import { EnvironmentNote } from "@/components/dashboards/EnvironmentNote";
import { WidgetView, widgetTitle } from "@/components/dashboards/WidgetView";
import { knownEvents } from "@/components/engage/shared";
import { NotFoundError } from "@/lib/errors";
import { ADD_WIDGET_TYPES, WIDGET_TYPE_LABELS } from "@/modules/dashboards/form";
import { getDashboard, runWidget } from "@/modules/dashboards/service";
import { can } from "@/modules/rbac/authorize";
import { audienceOptions } from "@/server/analytics-page";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

const MOVE_BUTTONS = [
  ["up", "↑", "Move up"],
  ["down", "↓", "Move down"],
  ["narrower", "−W", "Narrower"],
  ["wider", "+W", "Wider"],
  ["shorter", "−H", "Shorter"],
  ["taller", "+H", "Taller"],
] as const;

export const metadata = { title: "Dashboard" };

export default async function DashboardPage(props: PageProps<"/o/[org]/apps/[app]/analytics/dashboards/[id]">) {
  const { org, app, id } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  requirePermission(ctx, "analytics.read");
  const env = await pickEnvironment(environments, sp.env);
  const { dashboard: d, widgets } = await getDashboard(ctx, id).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  const scope = { appId: a.id, environmentId: env.id, timezone: a.timezone };
  const fresh = param(sp.fresh) === "1";
  // Each widget runs its own bounded report; one that fails shows its message.
  const results = await Promise.all(widgets.map((w) => runWidget(ctx, scope, w, { fresh })));
  const canEdit = can(ctx.role, "analytics.write") && (d.visibility === "workspace" || d.created_by === ctx.userId);
  const base = `/o/${org}/apps/${app}/analytics`;
  const here = `${base}/dashboards/${d.id}?env=${env.type}`;
  const editing = canEdit && param(sp.edit) === "1";
  const adding = canEdit ? ADD_WIDGET_TYPES.find((t) => t === param(sp.add)) : undefined;
  const [events, audiences] = adding ? await Promise.all([knownEvents(ctx, env.id), audienceOptions(ctx, env.id)]) : [[], []];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-ink-3"><Link className="hover:underline" href={`${base}/dashboards?env=${env.type}`}>Dashboards</Link> / {d.visibility === "private" ? "only you" : "workspace"}</p>
          <h1 className="h1">{d.name}</h1>
          {d.description && <p className="mt-1 max-w-3xl text-ink-2">{d.description}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <EnvironmentNote env={env.type} refresh={`${here}&fresh=1`} />
          {canEdit && (editing || adding
            ? <Link className="btn" href={here}>Done</Link>
            : <Link className="btn-secondary" href={`${here}&edit=1`}>Edit dashboard</Link>)}
        </div>
      </div>

      {(editing || adding) && (
        <section className="card space-y-3" aria-label="Add widget">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">Add a widget:</span>
            {ADD_WIDGET_TYPES.map((t) => (
              <Link key={t} className={`pill ${t === adding ? "border-accent bg-accent-soft text-accent-ink" : "border-line hover:border-line-strong"}`} href={`${here}&add=${t}`}>{WIDGET_TYPE_LABELS[t]}</Link>
            ))}
            <Link className="text-ink-3 underline" href={`${base}?env=${env.type}`}>or a saved report</Link>
          </div>
          {adding && (
            <div className="max-w-2xl">
              <AddWidgetForm org={org} app={app} dashboardId={d.id} type={adding} events={events} audiences={audiences} />
            </div>
          )}
        </section>
      )}

      {widgets.length === 0 ? (
        <div className="card text-sm text-ink-2">
          This dashboard is empty. {canEdit ? <><Link className="underline" href={`${here}&edit=1`}>Add a widget</Link>, or open <Link className="underline" href={`${base}?env=${env.type}`}>Saved reports</Link> and use &ldquo;Add to dashboard&rdquo;.</> : null}
        </div>
      ) : (
        // Widgets flow in their saved order; each spans its width and height.
        <div className="grid grid-cols-1 gap-4 md:grid-cols-12">
          {widgets.map((w, i) => {
            const r = results[i];
            return (
              <section
                key={w.id}
                className="card min-w-0 space-y-2 md:[grid-column:var(--col)] md:[grid-row:var(--row)]"
                style={{ "--col": `span ${w.w} / span ${w.w}`, "--row": `span ${w.h} / span ${w.h}` } as React.CSSProperties}
                data-widget={w.type}
              >
                <div className="flex items-start justify-between gap-2">
                  <h2 className="truncate font-medium">{w.title ?? (r.ok ? widgetTitle(r.data) : w.saved_report_name ?? "Widget")}</h2>
                  {editing && (
                    <ActionForm action={removeWidgetAction.bind(null, org, app, d.id, w.id)} submitLabel="Remove" className="" buttonClass="text-xs text-ink-3 hover:text-alert" confirm="Remove this widget?" />
                  )}
                </div>
                {editing && (
                  <form action={moveWidgetAction.bind(null, org, app, d.id, w.id)} className="flex flex-wrap gap-1" aria-label="Arrange widget">
                    {MOVE_BUTTONS.map(([move, label, title]) => (
                      <button key={move} type="submit" name="move" value={move} title={title} aria-label={title} className="rounded border border-line px-2 py-0.5 text-xs text-ink-2 hover:border-line-strong">{label}</button>
                    ))}
                  </form>
                )}
                {w.saved_report_name && <p className="text-xs text-ink-3">Saved report: {w.saved_report_name}</p>}
                <WidgetView result={r} />
              </section>
            );
          })}
        </div>
      )}

      {canEdit && (
        <details className="card">
          <summary className="cursor-pointer font-medium">Dashboard settings</summary>
          <div className="mt-3 grid gap-6 md:grid-cols-2">
            <ActionForm action={updateDashboardAction.bind(null, org, app, d.id)} submitLabel="Save">
              <label className="block"><span className="label">Name</span><input name="name" className="input" required maxLength={80} defaultValue={d.name} /></label>
              <label className="block"><span className="label">Description</span><input name="description" className="input" maxLength={500} defaultValue={d.description ?? ""} /></label>
              <fieldset className="space-y-1 text-sm">
                <legend className="label">Shared with</legend>
                <label className="flex items-center gap-2"><input type="radio" name="visibility" value="workspace" defaultChecked={d.visibility === "workspace"} /> Workspace</label>
                <label className="flex items-center gap-2"><input type="radio" name="visibility" value="private" defaultChecked={d.visibility === "private"} /> Only me</label>
              </fieldset>
            </ActionForm>
            <div>
              <ActionForm action={deleteDashboardAction.bind(null, org, app, d.id)} submitLabel="Delete dashboard" buttonClass="btn-danger" className="" confirm={`Delete the dashboard "${d.name}"? Saved reports on it are kept.`} />
            </div>
          </div>
        </details>
      )}
    </div>
  );
}
