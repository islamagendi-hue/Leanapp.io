import Link from "next/link";
import { fmtDate } from "@/components/engage/shared";
import { ExperimentStatusPill } from "@/components/engage/experiments";
import { getLang, getT } from "@/i18n/server";
import { listAudiences } from "@/modules/audiences/service";
import { EXPERIMENT_CAPABILITIES, EXPERIMENT_STATUS_LABELS, type ExperimentCapabilityStatus } from "@/modules/experiments/capabilities";
import { listExperiments } from "@/modules/experiments/service";
import { can } from "@/modules/rbac/authorize";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export async function generateMetadata() {
  return { title: (await getT())("Experiments") };
}

const STATUS_CLASS: Record<ExperimentCapabilityStatus, string> = {
  live: "border-accent/40 bg-accent-soft text-accent-ink",
  beta: "border-warn/40 bg-warn-soft text-warn",
  not_built: "border-line text-ink-3",
};

export default async function ExperimentsPage(props: PageProps<"/o/[org]/apps/[app]/engage/experiments">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, environments } = await loadApp(org, app);
  requirePermission(ctx, "automations.read");
  const env = await pickEnvironment(environments, sp.env);
  const [experiments, audiences] = await Promise.all([
    listExperiments(ctx, env.id),
    can(ctx.role, "audiences.read") ? listAudiences(ctx, env.id, { includeArchived: true }) : Promise.resolve([]),
  ]);
  const [t, lang] = await Promise.all([getT(), getLang()]);
  const base = `/o/${org}/apps/${app}/engage/experiments`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="h1">{t("Experiments")} <span className="pill border-warn/40 bg-warn-soft align-middle text-xs text-warn">{t("Beta")}</span></h1>
          <p className="mt-1 max-w-2xl text-ink-2">{t("Show different versions of a screen or a feature to different people, then see which one gets more of them to your goal.")}</p>
        </div>
        {can(ctx.role, "automations.manage") && <Link className="btn" href={`${base}/new?env=${env.type}`}>{t("New experiment")}</Link>}
      </div>

      <section className="card">
        {experiments.length === 0 ? <p className="text-sm text-ink-3">{t("No experiments in the {env} environment yet.", { env: t(env.type) })}</p> : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>{t("Name")}</th><th>{t("Status")}</th><th>{t("Key")}</th><th>{t("Variants")}</th><th>{t("Who")}</th><th>{t("Goal")}</th><th>{t("Started")}</th></tr></thead>
              <tbody>
                {experiments.map((x) => (
                  <tr key={x.id}>
                    <td><Link className="font-medium hover:underline" href={`${base}/${x.id}`}>{x.name}</Link></td>
                    <td><ExperimentStatusPill status={x.status} /></td>
                    <td className="font-mono text-xs" dir="ltr">{x.key}</td>
                    <td className="text-sm">{x.variants.map((v) => v.name).join(" · ")}</td>
                    <td className="text-sm">{x.audienceId ? (audiences.find((a) => a.id === x.audienceId)?.name ?? t("an audience")) : t("Everyone")}{x.trafficPercent < 100 ? ` · ${x.trafficPercent}%` : ""}</td>
                    <td className="font-mono text-xs" dir="ltr">{x.goal.event}</td>
                    <td className="text-xs text-ink-2">{fmtDate(x.startedAt, lang)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card space-y-3" aria-label={t("What works today")}>
        <h2 className="h2">{t("What works today")}</h2>
        <ul className="divide-y divide-line">
          {EXPERIMENT_CAPABILITIES.map((c) => (
            <li key={c.key} data-capability={c.key} className="flex flex-wrap items-start justify-between gap-2 py-2">
              <div className="max-w-2xl"><p className="font-medium">{t(c.label)}</p><p className="text-sm text-ink-2">{t(c.detail)}</p></div>
              <span className={`pill text-xs ${STATUS_CLASS[c.status]}`}>{t(EXPERIMENT_STATUS_LABELS[c.status])}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
