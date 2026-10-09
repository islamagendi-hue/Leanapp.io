import Link from "next/link";
import { notFound } from "next/navigation";
import { deleteDashboardAction, moveWidgetAction, removeWidgetAction, updateDashboardAction } from "@/app/actions/dashboards";
import { ActionForm } from "@/components/ActionForm";
import { param } from "@/components/AnalyticsHeader";
import { AddWidgetForm } from "@/components/dashboards/AddWidgetForm";
import { EnvironmentNote } from "@/components/dashboards/EnvironmentNote";
import { rich } from "@/components/dashboards/rich";
import { WidgetView, widgetTitle } from "@/components/dashboards/WidgetView";
import { knownEvents } from "@/components/engage/shared";
import { getLang, getT } from "@/i18n/server";
import { msg } from "@/i18n/translate";
import { NotFoundError } from "@/lib/errors";
import { ADD_WIDGET_TYPES, WIDGET_TYPE_LABELS } from "@/modules/dashboards/form";
import { getDashboard, runWidget } from "@/modules/dashboards/service";
import { can } from "@/modules/rbac/authorize";
import { audienceOptions } from "@/server/analytics-page";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

const MOVE_BUTTONS = [
  ["up", "↑", msg("Move up")],
  ["down", "↓", msg("Move down")],
  ["narrower", "−W", msg("Narrower")],
  ["wider", "+W", msg("Wider")],
  ["shorter", "−H", msg("Shorter")],
  ["taller", "+H", msg("Taller")],
] as const;

export async function generateMetadata() {
  return { title: (await getT())("Dashboard") };
}

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
  const [t, lang] = await Promise.all([getT(), getLang()]);
  const base = `/o/${org}/apps/${app}/analytics`;
  const here = `${base}/dashboards/${d.id}?env=${env.type}`;
  const editing = canEdit && param(sp.edit) === "1";
  const adding = canEdit ? ADD_WIDGET_TYPES.find((x) => x === param(sp.add)) : undefined;
  const [events, audiences] = adding ? await Promise.all([knownEvents(ctx, env.id), audienceOptions(ctx, env.id)]) : [[], []];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-ink-3"><Link className="hover:underline" href={`${base}/dashboards?env=${env.type}`}>{t("Dashboards")}</Link> / {d.visibility === "private" ? t("only you") : t("workspace")}</p>
          <h1 className="h1">{d.name}</h1>
          {d.description && <p className="mt-1 max-w-3xl text-ink-2">{d.description}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <EnvironmentNote env={env.type} refresh={`${here}&fresh=1`} />
          {canEdit && (editing || adding
            ? <Link className="btn" href={here}>{t("Done")}</Link>
            : <Link className="btn-secondary" href={`${here}&edit=1`}>{t("Edit dashboard")}</Link>)}
        </div>
      </div>

      {(editing || adding) && (
        <section className="card space-y-3" aria-label={t("Add widget")}>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{t("Add a widget:")}</span>
            {ADD_WIDGET_TYPES.map((type) => (
              <Link key={type} className={`pill ${type === adding ? "border-accent bg-accent-soft text-accent-ink" : "border-line hover:border-line-strong"}`} href={`${here}&add=${type}`}>{t(WIDGET_TYPE_LABELS[type])}</Link>
            ))}
            <Link className="text-ink-3 underline" href={`${base}?env=${env.type}`}>{t("or a saved report")}</Link>
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
          {t("This dashboard is empty.")} {canEdit ? rich(t("{add}, or open {reports} and use “Add to dashboard”."), {
            add: <Link className="underline" href={`${here}&edit=1`}>{t("Add a widget")}</Link>,
            reports: <Link className="underline" href={`${base}?env=${env.type}`}>{t("Saved reports")}</Link>,
          }) : null}
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
                  <h2 className="truncate font-medium">{w.title ?? (r.ok ? widgetTitle(r.data, t, lang) : w.saved_report_name ?? t("Widget"))}</h2>
                  {editing && (
                    <ActionForm action={removeWidgetAction.bind(null, org, app, d.id, w.id)} submitLabel={t("Remove")} className="" buttonClass="text-xs text-ink-3 hover:text-alert" confirm={t("Remove this widget?")} />
                  )}
                </div>
                {editing && (
                  <form action={moveWidgetAction.bind(null, org, app, d.id, w.id)} className="flex flex-wrap gap-1" aria-label={t("Arrange widget")}>
                    {MOVE_BUTTONS.map(([move, label, title]) => (
                      <button key={move} type="submit" name="move" value={move} title={t(title)} aria-label={t(title)} className="rounded border border-line px-2 py-0.5 text-xs text-ink-2 hover:border-line-strong">{label}</button>
                    ))}
                  </form>
                )}
                {w.saved_report_name && <p className="text-xs text-ink-3">{t("Saved report: {name}", { name: w.saved_report_name })}</p>}
                <WidgetView result={r} />
              </section>
            );
          })}
        </div>
      )}

      {canEdit && (
        <details className="card">
          <summary className="cursor-pointer font-medium">{t("Dashboard settings")}</summary>
          <div className="mt-3 grid gap-6 md:grid-cols-2">
            <ActionForm action={updateDashboardAction.bind(null, org, app, d.id)} submitLabel={t("Save")}>
              <label className="block"><span className="label">{t("Name")}</span><input name="name" className="input" required maxLength={80} defaultValue={d.name} /></label>
              <label className="block"><span className="label">{t("Description")}</span><input name="description" className="input" maxLength={500} defaultValue={d.description ?? ""} /></label>
              <fieldset className="space-y-1 text-sm">
                <legend className="label">{t("Shared with")}</legend>
                <label className="flex items-center gap-2"><input type="radio" name="visibility" value="workspace" defaultChecked={d.visibility === "workspace"} /> {t("Workspace")}</label>
                <label className="flex items-center gap-2"><input type="radio" name="visibility" value="private" defaultChecked={d.visibility === "private"} /> {t("Only me")}</label>
              </fieldset>
            </ActionForm>
            <div>
              <ActionForm action={deleteDashboardAction.bind(null, org, app, d.id)} submitLabel={t("Delete dashboard")} buttonClass="btn-danger" className="" confirm={t('Delete the dashboard "{name}"? Saved reports on it are kept.', { name: d.name })} />
            </div>
          </div>
        </details>
      )}
    </div>
  );
}
