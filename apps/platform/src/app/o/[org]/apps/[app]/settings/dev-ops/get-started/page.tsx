import Link from "next/link";
import { progress } from "@/modules/implementation/questions";
import { getProject, implementationReport, listVersions } from "@/modules/implementation/service";
import { getAppFeatures } from "@/modules/apps/features";
import { growthOverview } from "@/modules/growth/service";
import { can } from "@/modules/rbac/authorize";
import { getLang, getT } from "@/i18n/server";
import { dateLocale, msg } from "@/i18n/translate";
import { loadApp } from "@/server/session";

export async function generateMetadata() {
  return { title: (await getT())("Get started") };
}

export default async function GetStartedPage(props: PageProps<"/o/[org]/apps/[app]/settings/dev-ops/get-started">) {
  const { org, app } = await props.params;
  const { ctx, app: a, environments } = await loadApp(org, app);
  const base = `/o/${org}/apps/${app}`;
  const project = await getProject(ctx, a.id);
  const versions = await listVersions(ctx, a.id);
  const q = progress(project.answers);
  const dev = environments.find((e) => e.type === "development")!;
  const reports = await Promise.all(environments.map(async (e) => ({ env: e, report: await implementationReport(ctx, a.id, e.id) })));
  const firstEvent = reports.find((r) => r.report.lastEventAt);
  const devReport = reports.find((r) => r.env.id === dev.id)!.report;
  const t = await getT();
  const lang = await getLang();

  const steps = [
    { label: t("Create the app"), short: msg("Create the app"), done: true, href: `${base}/settings/dev-ops/get-started` },
    { label: t("Answer questions about your business ({answered}/{total})", { answered: q.answered, total: q.total }), short: msg("Answer questions about your business"), done: q.complete, href: `${base}/settings/dev-ops/implementation/questions` },
    { label: t("Generate your tracking plan"), short: msg("Generate your tracking plan"), done: versions.length > 0, href: `${base}/settings/dev-ops/implementation/plan` },
    { label: t("Review and approve it"), short: msg("Review and approve it"), done: versions.some((v) => v.status === "approved" || v.status === "published" || (v.status === "archived" && v.approved_at)), href: `${base}/settings/dev-ops/implementation/plan` },
    { label: t("Publish it"), short: msg("Publish it"), done: !!project.publishedVersionId, href: `${base}/settings/dev-ops/implementation/plan` },
    { label: t("Install the SDK"), short: msg("Install the SDK"), done: !!firstEvent, href: `${base}/settings/dev-ops/sdk?env=development` },
    { label: t("Send your first event"), short: msg("Send your first event"), done: !!firstEvent, href: `${base}/settings/dev-ops/debugger?env=development` },
    { label: t("Reach a healthy implementation score"), short: msg("Reach a healthy implementation score"), done: (devReport.score?.overall ?? 0) >= 80, href: `${base}/settings/dev-ops/events?env=development` },
  ];
  // With the growth model on, setup ends on the growth summary.
  if ((await getAppFeatures(ctx, a.id)).growth_model && can(ctx.role, "growth.read")) {
    const growth = await growthOverview(ctx, a.id, dev.id);
    steps.push(
      { label: t("Define activation, core action and revenue"), short: msg("Define activation, core action and revenue"), done: !!growth.definitions.published && (growth.definitions.published.saved || !!growth.definitions.published.definition.activation), href: `${base}/growth/setup` },
      { label: t("See your growth summary"), short: msg("See your growth summary"), done: (growth.summary?.people ?? 0) > 0, href: `${base}/growth` },
    );
  }
  const next = steps.find((s) => !s.done);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="h1">{t("Get started")}</h1>
        <p className="mt-1 text-ink-2">{t("From business model to production-ready tracking. The first event is the moment it all connects.")}</p>
      </div>
      <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
        <ol className="card space-y-1">
          {steps.map((s, i) => (
            <li key={s.label}>
              <Link href={s.href} className={`flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-paper-2 ${s === next ? "bg-accent-soft" : ""}`}>
                <span className={`grid size-7 shrink-0 place-items-center rounded-full font-mono text-xs ${s.done ? "bg-accent text-paper" : "border border-line-strong text-ink-3"}`}>
                  {s.done ? "✓" : i + 1}
                </span>
                <span className={s.done ? "text-ink-2" : "font-medium"}>{s.label}</span>
              </Link>
            </li>
          ))}
        </ol>
        <div className="space-y-4">
          <div className="card">
            <p className="eyebrow">{t("Implementation score · development")}</p>
            <p className="mt-2 text-4xl font-bold">{devReport.score ? `${devReport.score.overall}%` : "–"}</p>
            <p className="mt-1 text-sm text-ink-3">{devReport.score ? t("{validated}/{expected} planned events validated", { validated: devReport.score.validated, expected: devReport.score.expected }) : t("Publish a tracking plan to start scoring.")}</p>
          </div>
          {next && <Link href={next.href} className="btn w-full">{t("Next: {step}", { step: t(next.short) })}</Link>}
          <div className="card text-sm">
            <p className="eyebrow">{t("Environments")}</p>
            <ul className="mt-2 space-y-1">
              {reports.map(({ env, report }) => (
                <li key={env.id} className="flex justify-between">
                  <span className="capitalize">{t(env.type)}</span>
                  <span className="text-ink-3">{report.lastEventAt ? t("last event {date}", { date: new Date(report.lastEventAt).toLocaleString(dateLocale(lang)) }) : t("no events")}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
