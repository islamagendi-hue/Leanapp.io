import Link from "next/link";
import { CHANNEL_NO_INSTALL, CHANNEL_ORGANIC, CHANNEL_UNKNOWN } from "@/modules/analytics/sql";
import { AnalyticsHeader, param, rich } from "@/components/AnalyticsHeader";
import { getLang, getT } from "@/i18n/server";
import { dateLocale, msg, type T } from "@/i18n/translate";
import { EventName } from "@/components/EventName";
import { AutoApply } from "@/components/AutoApply";
import { CohortSelect } from "@/components/CohortSelect";
import { RateDelta, ReportRangeFields } from "@/components/ReportRange";
import { SaveReport } from "@/components/SaveReport";
import { rangePhrase, resolveRange, spanLabel } from "@/modules/analytics/range";
import { rangeFromParams, toSearch } from "@/modules/analytics/report-params";
import { eventLabels } from "@/modules/analytics/labels";
import { FUNNEL_PEOPLE_LIMIT, funnel, funnelPeople, topEvents } from "@/modules/analytics/service";
import { ReportFreshness } from "@/components/ReportFreshness";
import { cohortFilter, reportRunner } from "@/server/analytics-page";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

const CHANNEL_LABELS: Record<string, string> = { [CHANNEL_ORGANIC]: msg("organic"), [CHANNEL_UNKNOWN]: msg("Unknown source"), [CHANNEL_NO_INSTALL]: msg("No install on record") };

export async function generateMetadata() {
  const t = await getT();
  return { title: t("Funnels") };
}

const WINDOWS = [1, 3, 7, 14, 30];
const pct = (x: number) => `${(x * 100).toFixed(x > 0 && x < 0.1 ? 1 : 0)}%`;
function duration(t: T, s: number | null): string {
  if (s === null) return "";
  if (s < 90) return t("{n}s", { n: s });
  if (s < 5400) return t("{n} min", { n: Math.round(s / 60) });
  if (s < 172800) return t("{n} h", { n: Math.round(s / 3600) });
  return t("{n} days", { n: Math.round(s / 86400) });
}
const daysText = (t: T, n: number) => (n === 1 ? t("1 day") : t("{n} days", { n }));

export default async function FunnelsPage(props: PageProps<"/o/[org]/apps/[app]/analytics/funnels">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  requirePermission(ctx, "analytics.read");
  const [t, lang] = await Promise.all([getT(), getLang()]);
  const env = await pickEnvironment(environments, sp.env);
  const range = rangeFromParams(toSearch(sp));
  const windowDays = Number(param(sp.window)) || 7;
  const split = param(sp.split) === "platform" ? "platform" : param(sp.split) === "channel" ? "channel" : undefined;
  const chosen = (Array.isArray(sp.step) ? sp.step : sp.step ? [sp.step] : []).map((s) => s.trim()).filter(Boolean).slice(0, 10);
  const cf = await cohortFilter(ctx, env.id, sp.cohort);
  const scope = { environmentId: env.id, timezone: a.timezone };
  const reports = reportRunner(ctx, scope, sp);
  const events = await reports.run("top_events", { ...range }, () => topEvents(ctx, { ...scope, ...range }));
  const funnelInput = { steps: chosen, windowDays, ...range, breakdown: split, cohortId: cf.cohortId };
  const result = chosen.length >= 1 ? await reports.run("funnel", funnelInput, () => funnel(ctx, scope, funnelInput)) : null;
  // Always at least five step slots; a funnel already runs from one step.
  const slots = Math.min(10, Math.max(5, chosen.length + 1));
  const label = await eventLabels(ctx, a.id, t);
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
  const when = (d: Date) => new Date(d).toLocaleString(dateLocale(lang), { dateStyle: "medium", timeStyle: "short", timeZone: a.timezone });
  const names = [...new Set([...events.map((e) => e.name), ...chosen])];

  return (
    <div className="space-y-6">
      <AnalyticsHeader title={t("Funnels")} description={t("How many people go through a sequence of events, in order, within a time window.")} env={env.type} />
      <ReportFreshness info={reports.info} path={`/o/${org}/apps/${app}/analytics/funnels`} sp={sp} />

      <form method="get" className="card space-y-4">
        <input type="hidden" name="env" value={env.type} />
        <AutoApply />
        <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: slots }, (_, i) => (
            <li key={i}>
              <label className="block"><span className="label">{t("Step {n}", { n: i + 1 })}</span>
                <select name="step" className="input" defaultValue={chosen[i] ?? ""}>
                  <option value="">{i < 1 ? t("Choose an event") : t("Add a step (optional)")}</option>
                  {names.map((n) => <option key={n} value={n}>{label(n)}</option>)}
                </select>
              </label>
            </li>
          ))}
        </ol>
        <div className="flex flex-wrap items-end gap-3">
          <label><span className="label">{t("Converted within")}</span>
            <select name="window" className="input" defaultValue={String(windowDays)}>{WINDOWS.map((w) => <option key={w} value={w}>{daysText(t, w)}</option>)}</select>
          </label>
          <CohortSelect cohorts={cf.cohorts} value={cf.cohortId} />
          <ReportRangeFields label={t("People who started in")} range={result?.range ?? { ...resolveRange(range, a.timezone), previous: null }} />
          <label><span className="label">{t("Break down by")}</span>
            <select name="split" className="input" defaultValue={split ?? ""}>
              <option value="">{t("Nothing")}</option>
              <option value="platform">{t("Platform")}</option>
              <option value="channel">{t("Channel")}</option>
            </select>
          </label>
          <button className="btn" type="submit" data-apply>{t("Show funnel")}</button>
        </div>
      </form>

      {cf.missing && <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">{t("That audience is archived or no longer exists in this environment, so the funnel shows everyone.")}</p>}
      {!result ? (
        <p className="text-sm text-ink-3">{t("Choose at least one step.")} {events.length === 0 && t("There are no events in this environment and range yet.")}</p>
      ) : (
        <section className="card space-y-5">
          <p className="text-sm text-ink-2">
            {rich(t("{rate} of {people} people who started in {range} completed all {steps} steps within {window}."), {
              rate: <strong>{pct(result.steps.at(-1)!.fromStart)}</strong>,
              people: result.steps[0].people.toLocaleString("en-US"),
              range: rangePhrase(result.range, t, lang),
              steps: result.steps.length,
              window: daysText(t, windowDays),
            })}{" "}
            {result.previous && (
              <>
                <RateDelta value={result.steps.at(-1)!.fromStart} previous={result.previous.entered ? result.previous.converted / result.previous.entered : null} range={result.range} />{" "}
                <span className="text-xs text-ink-3">{t("vs {period} ({rate})", { period: spanLabel(result.range.previous!.from, result.range.previous!.to, lang), rate: result.previous.entered ? pct(result.previous.converted / result.previous.entered) : t("no one started") })}</span>
              </>
            )}
          </p>
          <ol className="space-y-4">
            {result.steps.map((s, i) => (
              <li key={i}>
                <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                  <span className="inline-flex items-baseline gap-1.5"><span className="text-ink-3">{i + 1}.</span> <EventName name={s.name} labels={label} /></span>
                  <span className="text-ink-2">
                    {rich(t("{people} people"), { people: <strong className="text-ink">{s.people.toLocaleString("en-US")}</strong> })} · {pct(s.fromStart)}
                    {i > 0 && <> · {t("{rate} from step {n}", { rate: pct(s.fromPrevious), n: i })}{s.medianSeconds !== null && <>{t(", median {time}", { time: duration(t, s.medianSeconds) })}</>}</>}
                  </span>
                </div>
                <Link href={peopleLink(String(i + 1))} scroll={false} aria-label={t("See the {people} people who reached step {n}", { people: s.people, n: i + 1 })}
                  data-tip={`${t("{people} people", { people: s.people.toLocaleString("en-US") })} · ${pct(s.fromStart)}`}
                  className="group mt-1.5 block h-6 rounded bg-paper-2 focus-visible:outline-2">
                  <div className="h-full rounded bg-accent transition group-hover:brightness-110" style={{ width: `${Math.max(s.fromStart * 100, s.people ? 0.5 : 0)}%` }} />
                </Link>
                <p className="mt-1 flex flex-wrap gap-x-3 text-xs">
                  <Link className="text-accent-ink hover:underline" href={peopleLink(String(i + 1))} scroll={false}>{t("See who reached it")}</Link>
                  {i > 0 && result.steps[i - 1].people > s.people && (
                    <Link className="text-alert hover:underline" href={peopleLink(`${i + 1}-dropped`)} scroll={false}>
                      {t("See the {people} who dropped off", { people: (result.steps[i - 1].people - s.people).toLocaleString("en-US") })}
                    </Link>
                  )}
                </p>
              </li>
            ))}
          </ol>
          {result.breakdown && (
            <div className="overflow-x-auto">
              <table className="table">
                <thead><tr><th>{split === "channel" ? t("Channel") : t("Platform")}</th>{result.steps.map((s, i) => <th key={i} className="text-end">{i + 1}. {label(s.name)}</th>)}<th className="text-end">{t("Overall")}</th></tr></thead>
                <tbody>
                  {result.breakdown.map((g) => (
                    <tr key={g.key}>
                      <td>{g.key === "(none)" ? t("(none)") : split === "channel" && CHANNEL_LABELS[g.key] ? t(CHANNEL_LABELS[g.key]) : g.key}</td>
                      {g.people.map((n, i) => <td key={i} className="text-end tabular-nums">{n.toLocaleString("en-US")}</td>)}
                      <td className="text-end tabular-nums">{g.people[0] ? pct(g.people.at(-1)! / g.people[0]) : "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {who && pick && (
            <section id="people" className="rounded-lg border border-line" aria-label={t("People behind this step")}>
              <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3">
                <h3 className="font-bold">
                  {pick.dropped
                    ? t("Dropped off before step {n} ({event})", { n: pick.step + 1, event: label(chosen[pick.step]) })
                    : t("Reached step {n} ({event})", { n: pick.step + 1, event: label(chosen[pick.step]) })}
                  <span className="ms-2 font-normal text-ink-3">{t("{people} people", { people: who.total.toLocaleString("en-US") })}</span>
                </h3>
                <Link className="text-sm underline" href={peopleLink(null)} scroll={false}>{t("Close")}</Link>
              </div>
              {who.people.length === 0 ? <p className="px-4 py-3 text-sm text-ink-3">{t("No one.")}</p> : (
                <div className="max-h-96 overflow-auto">
                  <table className="table">
                    <thead><tr><th>{t("Person")}</th><th>{t("Did step {n}", { n: pick.dropped ? pick.step : pick.step + 1 })}</th></tr></thead>
                    <tbody>
                      {who.people.map((p) => (
                        <tr key={p.userId ?? `anon:${p.anonymousId}`}>
                          <td className="font-mono text-sm"><Link className="underline" href={profile(p)}>{p.userId ?? p.anonymousId}</Link>{!p.userId && <span className="ms-2 font-sans text-xs text-ink-3">{t("anonymous")}</span>}</td>
                          <td className="whitespace-nowrap text-sm">{when(p.at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {who.total > who.people.length && <p className="px-4 py-2 text-xs text-ink-3">{t("Showing the {limit} most recent of {total}.", { limit: FUNNEL_PEOPLE_LIMIT, total: who.total.toLocaleString("en-US") })}</p>}
            </section>
          )}
          {cf.cohortName && <p className="text-xs text-ink-3">{t("Only people in the audience {audience}.", { audience: cf.cohortName })}</p>}
          <p className="text-xs text-ink-3">{t("A person enters at their first step-1 event in the range; each later step must happen after the previous one and within the window from entering.")}</p>
        </section>
      )}
      {result && cf.canSave && <SaveReport org={org} app={app} environmentId={env.id} kind="funnel" query={{ ...sp, people: undefined }} />}
    </div>
  );
}
