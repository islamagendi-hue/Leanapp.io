import Link from "next/link";
import { createDashboardAction, createFromTemplateAction } from "@/app/actions/dashboards";
import { ActionForm } from "@/components/ActionForm";
import { envName } from "@/components/dashboards/EnvironmentNote";
import { AnalyticsHeader } from "@/components/AnalyticsHeader";
import { getT } from "@/i18n/server";
import { listDashboards, templateFacts } from "@/modules/dashboards/service";
import { planTemplate, TEMPLATE_INFO, TEMPLATES } from "@/modules/dashboards/templates";
import { can } from "@/modules/rbac/authorize";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export async function generateMetadata() {
  return { title: (await getT())("Dashboards") };
}

export default async function DashboardsPage(props: PageProps<"/o/[org]/apps/[app]/analytics/dashboards">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  requirePermission(ctx, "analytics.read");
  const env = await pickEnvironment(environments, sp.env);
  const dashboards = await listDashboards(ctx, a.id);
  const canWrite = can(ctx.role, "analytics.write");
  const t = await getT();
  const base = `/o/${org}/apps/${app}/analytics/dashboards`;
  // Templates are previewed from this environment's data, so people see what they'd get.
  const facts = canWrite ? await templateFacts(ctx, { appId: a.id, environmentId: env.id, timezone: a.timezone }) : null;

  return (
    <div className="space-y-6">
      <AnalyticsHeader title={t("Dashboards")} description={t("Reports and numbers you check together, on one page. A dashboard belongs to the project and shows the selected environment.")} env={env.type} />

      <section className="card overflow-x-auto p-0">
        {dashboards.length === 0 ? (
          <p className="px-5 py-4 text-sm text-ink-3">{canWrite ? t("No dashboards yet. Create one below, then add saved reports to it from Saved reports.") : t("No dashboards yet.")}</p>
        ) : (
          <table className="table">
            <thead><tr><th className="text-start">{t("Name")}</th><th className="text-start">{t("Shared with")}</th><th className="text-end">{t("Widgets")}</th><th className="text-start">{t("Made by")}</th></tr></thead>
            <tbody>
              {dashboards.map((d) => (
                <tr key={d.id}>
                  <td>
                    <Link className="font-medium underline" href={`${base}/${d.id}?env=${env.type}`}>{d.name}</Link>
                    {d.description && <p className="text-xs text-ink-3">{d.description}</p>}
                  </td>
                  <td className="text-sm">{d.visibility === "private" ? t("Only you") : t("Workspace")}</td>
                  <td className="text-end tabular-nums">{d.widget_count}</td>
                  <td className="text-sm text-ink-3">{d.created_by_name ?? "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {facts && (
        <section className="space-y-3" aria-label={t("Templates")}>
          <div>
            <h2 className="h2">{t("Start from a template")}</h2>
            <p className="text-sm text-ink-3">{t("Built from this project's events and Activation steps in {env}. You can change every widget afterwards.", { env: envName(env.type, t) })}</p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {TEMPLATES.map((tpl) => {
              const plan = planTemplate(tpl, facts, t);
              return (
                <div key={tpl} className="card flex flex-col gap-3" data-template={tpl}>
                  <div>
                    <h3 className="font-medium">{t(TEMPLATE_INFO[tpl].name)}</h3>
                    <p className="text-sm text-ink-3">{t(TEMPLATE_INFO[tpl].description)}</p>
                  </div>
                  <ul className="list-disc space-y-0.5 ps-5 text-sm">{plan.widgets.map((w) => <li key={w.title}>{w.title}</li>)}</ul>
                  {plan.skipped.length > 0 && (
                    <div className="text-xs text-ink-3">
                      <p className="font-medium">{t("Left out for now:")}</p>
                      <ul className="list-disc ps-4">{plan.skipped.map((r) => <li key={r}>{r}</li>)}</ul>
                    </div>
                  )}
                  <ActionForm action={createFromTemplateAction.bind(null, org, app, env.type, tpl)} submitLabel={t("Create {name} dashboard", { name: t(TEMPLATE_INFO[tpl].name) })} className="mt-auto space-y-2" buttonClass="btn-secondary">
                    <input type="hidden" name="visibility" value="workspace" />
                  </ActionForm>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {canWrite && (
        <section className="card max-w-xl space-y-3">
          <h2 className="h2">{t("New dashboard")}</h2>
          <ActionForm action={createDashboardAction.bind(null, org, app, a.id)} submitLabel={t("Create dashboard")}>
            <label className="block"><span className="label">{t("Name")}</span><input name="name" className="input" required maxLength={80} /></label>
            <label className="block"><span className="label">{t("Description (optional)")}</span><input name="description" className="input" maxLength={500} /></label>
            <fieldset className="space-y-1 text-sm">
              <legend className="label">{t("Shared with")}</legend>
              <label className="flex items-center gap-2"><input type="radio" name="visibility" value="workspace" defaultChecked /> {t("Everyone in the workspace who can see analytics")}</label>
              <label className="flex items-center gap-2"><input type="radio" name="visibility" value="private" /> {t("Only me")}</label>
            </fieldset>
          </ActionForm>
        </section>
      )}
    </div>
  );
}
