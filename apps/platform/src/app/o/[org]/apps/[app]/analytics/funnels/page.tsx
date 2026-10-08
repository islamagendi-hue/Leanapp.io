import { AnalyticsHeader, param } from "@/components/AnalyticsHeader";
import { CohortSelect } from "@/components/CohortSelect";
import { RateDelta, ReportRangeFields } from "@/components/ReportRange";
import { SaveReport } from "@/components/SaveReport";
import { resolveRange } from "@/modules/analytics/range";
import { rangeFromParams, toSearch } from "@/modules/analytics/report-params";
import { funnel, topEvents } from "@/modules/analytics/service";
import { ReportFreshness } from "@/components/ReportFreshness";
import { cohortFilter, reportRunner } from "@/server/analytics-page";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export const metadata = { title: "Funnels" };

const WINDOWS = [1, 3, 7, 14, 30];
const pct = (x: number) => `${(x * 100).toFixed(x > 0 && x < 0.1 ? 1 : 0)}%`;
function duration(s: number | null): string {
  if (s === null) return "";
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} days`;
}

export default async function FunnelsPage(props: PageProps<"/o/[org]/apps/[app]/analytics/funnels">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  requirePermission(ctx, "analytics.read");
  const env = await pickEnvironment(environments, sp.env);
  const range = rangeFromParams(toSearch(sp));
  const windowDays = Number(param(sp.window)) || 7;
  const split = param(sp.split) === "platform";
  const chosen = (Array.isArray(sp.step) ? sp.step : sp.step ? [sp.step] : []).map((s) => s.trim()).filter(Boolean).slice(0, 6);
  const cf = await cohortFilter(ctx, env.id, sp.cohort);
  const scope = { environmentId: env.id, timezone: a.timezone };
  const reports = reportRunner(ctx, scope, sp);
  const events = await reports.run("top_events", { ...range }, () => topEvents(ctx, { ...scope, ...range }));
  const funnelInput = { steps: chosen, windowDays, ...range, breakdown: split ? "platform" : undefined, cohortId: cf.cohortId };
  const result = chosen.length >= 2 ? await reports.run("funnel", funnelInput, () => funnel(ctx, scope, funnelInput)) : null;
  const slots = Math.min(6, Math.max(2, chosen.length + 1));
  const names = [...new Set([...events.map((e) => e.name), ...chosen])];

  return (
    <div className="space-y-6">
      <AnalyticsHeader title="Funnels" description="How many people go through a sequence of events, in order, within a time window." env={env.type} />
      <ReportFreshness info={reports.info} path={`/o/${org}/apps/${app}/analytics/funnels`} sp={sp} />

      <form method="get" className="card space-y-4">
        <input type="hidden" name="env" value={env.type} />
        <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: slots }, (_, i) => (
            <li key={i}>
              <label className="block"><span className="label">Step {i + 1}</span>
                <select name="step" className="input" defaultValue={chosen[i] ?? ""}>
                  <option value="">{i < 2 ? "Choose an event" : "Add a step (optional)"}</option>
                  {names.map((n) => <option key={n}>{n}</option>)}
                </select>
              </label>
            </li>
          ))}
        </ol>
        <div className="flex flex-wrap items-end gap-3">
          <label><span className="label">Converted within</span>
            <select name="window" className="input" defaultValue={String(windowDays)}>{WINDOWS.map((w) => <option key={w} value={w}>{w === 1 ? "1 day" : `${w} days`}</option>)}</select>
          </label>
          <CohortSelect cohorts={cf.cohorts} value={cf.cohortId} />
          <ReportRangeFields label="People who started in" range={result?.range ?? { ...resolveRange(range, a.timezone), previous: null }} />
          <label className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" name="split" value="platform" defaultChecked={split} /> Split by platform</label>
          <button className="btn" type="submit">Show funnel</button>
        </div>
      </form>

      {cf.missing && <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">That audience is archived or no longer exists in this environment, so the funnel shows everyone.</p>}
      {!result ? (
        <p className="text-sm text-ink-3">Choose at least two steps. {events.length === 0 && "There are no events in this environment and range yet."}</p>
      ) : (
        <section className="card space-y-5">
          <p className="text-sm text-ink-2">
            <strong>{pct(result.steps.at(-1)!.fromStart)}</strong> of {result.steps[0].people.toLocaleString("en-US")} people who started in {result.range.preset ? `the ${result.range.label.toLowerCase()}` : result.range.label} completed all {result.steps.length} steps within {windowDays === 1 ? "1 day" : `${windowDays} days`}.{" "}
            {result.previous && (
              <>
                <RateDelta value={result.steps.at(-1)!.fromStart} previous={result.previous.entered ? result.previous.converted / result.previous.entered : null} range={result.range} />{" "}
                <span className="text-xs text-ink-3">vs {result.range.previous!.label} ({result.previous.entered ? pct(result.previous.converted / result.previous.entered) : "no one started"})</span>
              </>
            )}
          </p>
          <ol className="space-y-4">
            {result.steps.map((s, i) => (
              <li key={i}>
                <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                  <span><span className="text-ink-3">{i + 1}.</span> <span className="font-mono">{s.name}</span></span>
                  <span className="text-ink-2">
                    <strong className="text-ink">{s.people.toLocaleString("en-US")}</strong> people · {pct(s.fromStart)}
                    {i > 0 && <> · {pct(s.fromPrevious)} from step {i}{s.medianSeconds !== null && <>, median {duration(s.medianSeconds)}</>}</>}
                  </span>
                </div>
                <div className="mt-1.5 h-6 overflow-hidden rounded bg-paper-2">
                  <div className="h-full rounded bg-accent" style={{ width: `${Math.max(s.fromStart * 100, s.people ? 0.5 : 0)}%` }} />
                </div>
              </li>
            ))}
          </ol>
          {result.breakdown && (
            <div className="overflow-x-auto">
              <table className="table">
                <thead><tr><th>Platform</th>{result.steps.map((s, i) => <th key={i} className="text-end">{i + 1}. {s.name}</th>)}<th className="text-end">Overall</th></tr></thead>
                <tbody>
                  {result.breakdown.map((g) => (
                    <tr key={g.key}>
                      <td>{g.key}</td>
                      {g.people.map((n, i) => <td key={i} className="text-end tabular-nums">{n.toLocaleString("en-US")}</td>)}
                      <td className="text-end tabular-nums">{g.people[0] ? pct(g.people.at(-1)! / g.people[0]) : "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {cf.cohortName && <p className="text-xs text-ink-3">Only people in the audience {cf.cohortName}.</p>}
          <p className="text-xs text-ink-3">A person enters at their first step-1 event in the range; each later step must happen after the previous one and within the window from entering.</p>
        </section>
      )}
      {result && cf.canSave && <SaveReport org={org} app={app} environmentId={env.id} kind="funnel" query={sp} />}
    </div>
  );
}
