import Link from "next/link";
import { saveExperimentAction } from "@/app/actions/experiments";
import { ExperimentForm } from "@/components/engage/ExperimentForm";
import { knownEvents } from "@/components/engage/shared";
import { getT } from "@/i18n/server";
import { listAudiences } from "@/modules/audiences/service";
import { NEW_FORM } from "@/modules/experiments/definition";
import { can } from "@/modules/rbac/authorize";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export async function generateMetadata() {
  return { title: (await getT())("New experiment") };
}

export default async function NewExperimentPage(props: PageProps<"/o/[org]/apps/[app]/engage/experiments/new">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, environments } = await loadApp(org, app);
  requirePermission(ctx, "automations.manage");
  const env = await pickEnvironment(environments, sp.env);
  const [audiences, events] = await Promise.all([
    can(ctx.role, "audiences.read") ? listAudiences(ctx, env.id) : Promise.resolve([]),
    knownEvents(ctx, env.id),
  ]);
  const t = await getT();
  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-ink-3"><Link className="hover:underline" href={`/o/${org}/apps/${app}/engage/experiments?env=${env.type}`}>{t("Experiments")}</Link> / {t("new")}</p>
        <h1 className="h1">{t("New experiment")} <span className="pill border-line align-middle text-xs">{t(env.type)}</span></h1>
      </div>
      <section className="card">
        <ExperimentForm action={saveExperimentAction.bind(null, org, app, env.id, null)} initial={NEW_FORM} audiences={audiences} events={events} submitLabel={t("Save draft")} />
      </section>
    </div>
  );
}
