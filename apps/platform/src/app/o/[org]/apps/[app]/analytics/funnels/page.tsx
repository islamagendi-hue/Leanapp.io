import Link from "next/link";
import { AnalyticsHeader, param } from "@/components/AnalyticsHeader";
import { EventName } from "@/components/EventName";
import { AutoApply } from "@/components/AutoApply";
import { CohortSelect } from "@/components/CohortSelect";
import { RateDelta, ReportRangeFields } from "@/components/ReportRange";
import { SaveReport } from "@/components/SaveReport";
import { resolveRange } from "@/modules/analytics/range";
import { rangeFromParams, toSearch } from "@/modules/analytics/report-params";
import { eventLabels } from "@/modules/analytics/labels";
import { FUNNEL_PEOPLE_LIMIT, funnel, funnelPeople, topEvents } from "@/modules/analytics/service";
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
  const label = await eventLabels(ctx, a.id);
  // "people=3" lists who reached step 3, "people=3-dropped" who reached step 2 but not 3.
  const peopleParam = /^(\d)(-dropped)?$/.exec(param(sp.people) ?? "");
  const pick = peopleParam && result ? { step: Number(peopleParam[1]) - 1, dropped: Boolean(peopleParam[2]) } : null;
  const valid = pick && pick.step >= 0 && pick.step < chosen.length && !(pick.dropped && pick.step === 0);
  const who = valid ? await funnelPeople(ctx, scope, funnelInput, pick) : null;
  const path = `/o/${org}/apps/${app}/analytics/funnels`;
  const peopleLink = (v: string | null) => {
    const q = new URLSearchParams();
    for (const [k, x] of Object.entries(sp)) if (k !== "people") for (const one of Array.isArray(x) ? x : x ? [x] : []) q.append(k, one);
    if (!q.has("env")) q.set("env", env.type);
    if (v) q.set("people", v);
    return `${path}?${q}`;
  };
  const profile = (p: { userId: string | null; anonymousId: string | null }) =>
    `/o/${org}/apps/${app}/analytics/users/profile?${new URLSearchParams({ env: env.type, ...(p.userId ? { user: p.userId } : { anon: p.anonymousId! }) })}`;
  const when = (d: Date) => new Date(d).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: a.timezone });
  const names = [...new Set([...events.map((e) => e.name), ...chosen])];

  return (
    <div className="space-y-6">
      <AnalyticsHeader title="Funnels" description="How many people go through a sequence of events, in order, within a time window." env={env.type} />
      <ReportFreshness info={reports.info} path={`/o/${org}/apps/${app}/analytics/funnels`} sp={sp} />

      <form method="get" className="card space-y-4">
        <input type="hidden" name="env" value={env.type} />
        <AutoApply />
        <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: slots }, (_, i) => (
            <li key={i}>
              <label className="block"><span className="label">Step {i + 1}</span>
                <select name="step" className="input" defaultValue={chosen[i] ?? ""}>
                  <option value="">{i < 2 ? "Choose an event" : "Add a step (optional)"}</option>
                  {names.map((n) => <option key={n} value={n}>{label(n)}</option>)}
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
          <button className="btn" type="submit" data-apply>Show funnel</button>
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
                  <span className="inline-flex items-baseline gap-1.5"><span className="text-ink-3">{i + 1}.</span> <EventName name={s.name} labels={label} /></span>
                  <span className="text-ink-2">
                    <strong className="text-ink">{s.people.toLocaleString("en-US")}</strong> people · {pct(s.fromStart)}
                    {i > 0 && <> · {pct(s.fromPrevious)} from step {i}{s.medianSeconds !== null && <>, median {duration(s.medianSeconds)}</>}</>}
                  </span>
                </div>
                <Link href={peopleLink(String(i + 1))} scroll={false} aria-label={`See the ${s.people} people who reached step ${i + 1}`}
                  className="group mt-1.5 block h-6 overflow-hidden rounded bg-paper-2 focus-visible:outline-2">
                  <div className="h-full rounded bg-accent transition group-hover:brightness-110" style={{ width: `${Math.max(s.fromStart * 100, s.people ? 0.5 : 0)}%` }} />
                </Link>
                <p className="mt-1 flex flex-wrap gap-x-3 text-xs">
                  <Link className="text-accent-ink hover:underline" href={peopleLink(String(i + 1))} scroll={false}>See who reached it</Link>
                  {i > 0 && result.steps[i - 1].people > s.people && (
                    <Link className="text-alert hover:underline" href={peopleLink(`${i + 1}-dropped`)} scroll={false}>
                      See the {(result.steps[i - 1].people - s.people).toLocaleString("en-US")} who dropped off
                    </Link>
                  )}
                </p>
              </li>
            ))}
          </ol>
          {result.breakdown && (
            <div className="overflow-x-auto">
              <table className="table">
                <thead><tr><th>Platform</th>{result.steps.map((s, i) => <th key={i} className="text-end">{i + 1}. {label(s.name)}</th>)}<th className="text-end">Overall</th></tr></thead>
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
          {who && pick && (
            <section id="people" className="rounded-lg border border-line" aria-label="People behind this step">
              <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3">
                <h3 className="font-bold">
                  {pick.dropped
                    ? <>Dropped off before step {pick.step + 1} ({label(chosen[pick.step])})</>
                    : <>Reached step {pick.step + 1} ({label(chosen[pick.step])})</>}
                  <span className="ms-2 font-normal text-ink-3">{who.total.toLocaleString("en-US")} people</span>
                </h3>
                <Link className="text-sm underline" href={peopleLink(null)} scroll={false}>Close</Link>
              </div>
              {who.people.length === 0 ? <p className="px-4 py-3 text-sm text-ink-3">No one.</p> : (
                <div className="max-h-96 overflow-auto">
                  <table className="table">
                    <thead><tr><th>Person</th><th>{pick.dropped ? `Did step ${pick.step}` : `Did step ${pick.step + 1}`}</th></tr></thead>
                    <tbody>
                      {who.people.map((p) => (
                        <tr key={p.userId ?? `anon:${p.anonymousId}`}>
                          <td className="font-mono text-sm"><Link className="underline" href={profile(p)}>{p.userId ?? p.anonymousId}</Link>{!p.userId && <span className="ms-2 font-sans text-xs text-ink-3">anonymous</span>}</td>
                          <td className="whitespace-nowrap text-sm">{when(p.at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {who.total > who.people.length && <p className="px-4 py-2 text-xs text-ink-3">Showing the {FUNNEL_PEOPLE_LIMIT} most recent of {who.total.toLocaleString("en-US")}.</p>}
            </section>
          )}
          {cf.cohortName && <p className="text-xs text-ink-3">Only people in the audience {cf.cohortName}.</p>}
          <p className="text-xs text-ink-3">A person enters at their first step-1 event in the range; each later step must happen after the previous one and within the window from entering.</p>
        </section>
      )}
      {result && cf.canSave && <SaveReport org={org} app={app} environmentId={env.id} kind="funnel" query={{ ...sp, people: undefined }} />}
    </div>
  );
}
