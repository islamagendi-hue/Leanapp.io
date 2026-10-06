import Link from "next/link";
import { progress } from "@/modules/implementation/questions";
import { getProject, implementationReport, listVersions } from "@/modules/implementation/service";
import { loadApp } from "@/server/session";

export default async function AppSetupPage(props: PageProps<"/o/[org]/apps/[app]">) {
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

  const steps = [
    { label: "Create the app", done: true, href: base },
    { label: `Answer questions about your business (${q.answered}/${q.total})`, done: q.complete, href: `${base}/implementation/questions` },
    { label: "Generate your tracking plan", done: versions.length > 0, href: `${base}/implementation/plan` },
    { label: "Review and approve it", done: versions.some((v) => v.status === "approved" || v.status === "published" || (v.status === "archived" && v.approved_at)), href: `${base}/implementation/plan` },
    { label: "Publish it", done: !!project.publishedVersionId, href: `${base}/implementation/plan` },
    { label: "Install the SDK", done: !!firstEvent, href: `${base}/developers/sdk` },
    { label: "Send your first event", done: !!firstEvent, href: `${base}/developers/debugger` },
    { label: "Reach a healthy implementation score", done: (devReport.score?.overall ?? 0) >= 80, href: `${base}/implementation/validation` },
  ];
  const next = steps.find((s) => !s.done);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="h1">Setup</h1>
        <p className="mt-1 text-ink-2">From business model to production-ready tracking. The first event is the moment it all connects.</p>
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
            <p className="font-mono text-xs uppercase tracking-wide text-ink-3">Implementation score · development</p>
            <p className="mt-2 text-4xl font-bold">{devReport.score ? `${devReport.score.overall}%` : "–"}</p>
            <p className="mt-1 text-sm text-ink-3">{devReport.score ? `${devReport.score.validated}/${devReport.score.expected} planned events validated` : "Publish a tracking plan to start scoring."}</p>
          </div>
          {next && <Link href={next.href} className="btn w-full">Next: {next.label.replace(/ \(.*\)$/, "")}</Link>}
          <div className="card text-sm">
            <p className="font-mono text-xs uppercase tracking-wide text-ink-3">Environments</p>
            <ul className="mt-2 space-y-1">
              {reports.map(({ env, report }) => (
                <li key={env.id} className="flex justify-between">
                  <span className="capitalize">{env.type}</span>
                  <span className="text-ink-3">{report.lastEventAt ? `last event ${new Date(report.lastEventAt).toLocaleString("en-GB")}` : "no events"}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
