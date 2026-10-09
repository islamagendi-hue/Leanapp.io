import Link from "next/link";
import { notFound } from "next/navigation";
import { experimentLifecycleAction, saveExperimentAction } from "@/app/actions/experiments";
import { ActionForm } from "@/components/ActionForm";
import { ExperimentForm } from "@/components/engage/ExperimentForm";
import { ExperimentStatusPill, pct, pValueText, signedPct, signedPoints } from "@/components/engage/experiments";
import { knownEvents } from "@/components/engage/shared";
import { TrendChart } from "@/components/TrendChart";
import { getLang, getT } from "@/i18n/server";
import { dateLocale, fmtNumber, msg, type T } from "@/i18n/translate";
import { NotFoundError } from "@/lib/errors";
import { PROPERTY_OP_LABELS } from "@/modules/analytics/sql";
import { listAudiences } from "@/modules/audiences/service";
import { EXPOSURE_EVENT, formOf } from "@/modules/experiments/definition";
import { experimentResults, getExperiment, type MetricResult, type VariantResult } from "@/modules/experiments/service";
import { MIN_CONVERSIONS, MIN_EXPOSED } from "@/modules/experiments/stats";
import { can } from "@/modules/rbac/authorize";
import { loadApp, requirePermission } from "@/server/session";

export async function generateMetadata() {
  return { title: (await getT())("Experiment") };
}

const VERDICT_CLASS = { better: "text-accent-ink", worse: "text-alert", none: "text-ink-2", wait: "text-ink-3", control: "text-ink-3" } as const;

function verdict(m: MetricResult, isControl: boolean): keyof typeof VERDICT_CLASS {
  if (isControl) return "control";
  if (!m.enough || m.significant === null) return "wait";
  if (!m.significant) return "none";
  return (m.comparison?.diff ?? 0) > 0 ? "better" : "worse";
}
const VERDICT_TEXT: Record<keyof typeof VERDICT_CLASS, string> = {
  better: msg("Better than control"),
  worse: msg("Worse than control"),
  none: msg("No clear difference"),
  wait: msg("Not enough data yet"),
  control: msg("Baseline"),
};

function MetricTable({ t, variants, pick, caption }: { t: T; variants: VariantResult[]; pick: (v: VariantResult) => MetricResult; caption: string }) {
  return (
    <>
    {/* Phones get one block per variant: eight columns don't fit in 390px. */}
    <ul className="space-y-3 sm:hidden" aria-label={caption}>
      {variants.map((v, i) => {
        const m = pick(v);
        const c = m.comparison;
        const verdictKey = verdict(m, i === 0);
        return (
          <li key={v.key} className="rounded-lg border border-line p-3">
            <p className="flex flex-wrap items-baseline justify-between gap-2">
              <span><span className="font-medium">{v.name}</span> <span className="font-mono text-xs text-ink-3" dir="ltr">{v.key}</span></span>
              <span className={`text-sm ${VERDICT_CLASS[verdictKey]}`}>{t(VERDICT_TEXT[verdictKey])}</span>
            </p>
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              <dt className="text-ink-3">{t("Exposed")}</dt><dd className="text-end tabular-nums">{fmtNumber(v.exposed)}</dd>
              <dt className="text-ink-3">{t("Converted")}</dt><dd className="text-end tabular-nums">{fmtNumber(m.conversions)}</dd>
              <dt className="text-ink-3">{t("Rate")}</dt><dd className="text-end tabular-nums">{pct(m.rate)}</dd>
              {c && (
                <>
                  <dt className="text-ink-3">{t("Uplift (95% CI)")}</dt>
                  <dd className="text-end tabular-nums" dir="ltr">{c.uplift !== null ? <>{signedPct(c.uplift)}{c.upliftLow !== null && c.upliftHigh !== null && <span className="block text-xs text-ink-3">{`${signedPct(c.upliftLow)} … ${signedPct(c.upliftHigh)}`}</span>}</> : "–"}</dd>
                  <dt className="text-ink-3">{t("p-value")}</dt><dd className="text-end tabular-nums" dir="ltr">{pValueText(c.pValue)}</dd>
                </>
              )}
            </dl>
          </li>
        );
      })}
    </ul>
    <div className="hidden overflow-x-auto sm:block">
      <table className="table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th>{t("Variant")}</th><th className="text-end">{t("Exposed")}</th><th className="text-end">{t("Converted")}</th><th className="text-end">{t("Rate")}</th>
            <th className="text-end">{t("Uplift (95% CI)")}</th><th className="text-end">{t("Points (95% CI)")}</th><th className="text-end">{t("p-value")}</th><th>{t("Result")}</th>
          </tr>
        </thead>
        <tbody>
          {variants.map((v, i) => {
            const m = pick(v);
            const c = m.comparison;
            const verdictKey = verdict(m, i === 0);
            return (
              <tr key={v.key}>
                <td><span className="font-medium">{v.name}</span> <span className="font-mono text-xs text-ink-3" dir="ltr">{v.key}</span></td>
                <td className="text-end tabular-nums">{fmtNumber(v.exposed)}</td>
                <td className="text-end tabular-nums">{fmtNumber(m.conversions)}</td>
                <td className="whitespace-nowrap text-end tabular-nums">{pct(m.rate)}</td>
                <td className="whitespace-nowrap text-end tabular-nums" dir="ltr">{c && c.uplift !== null ? <>{signedPct(c.uplift)}{c.upliftLow !== null && c.upliftHigh !== null && <span className="block text-xs text-ink-3">{`${signedPct(c.upliftLow)} … ${signedPct(c.upliftHigh)}`}</span>}</> : "–"}</td>
                <td className="whitespace-nowrap text-end tabular-nums" dir="ltr">{c ? <>{signedPoints(c.diff)}<span className="block text-xs text-ink-3">{`${signedPoints(c.diffLow)} … ${signedPoints(c.diffHigh)}`}</span></> : "–"}</td>
                <td className="whitespace-nowrap text-end tabular-nums" dir="ltr">{c ? pValueText(c.pValue) : "–"}</td>
                <td className={`text-sm ${VERDICT_CLASS[verdictKey]}`}>{t(VERDICT_TEXT[verdictKey])}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
    </>
  );
}

export default async function ExperimentPage(props: PageProps<"/o/[org]/apps/[app]/engage/experiments/[id]">) {
  const { org, app, id } = await props.params;
  const { ctx, app: a, environments } = await loadApp(org, app);
  requirePermission(ctx, "automations.read");
  const x = await getExperiment(ctx, id).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  const env = environments.find((e) => e.id === x.environmentId);
  if (!env) notFound();
  const manage = can(ctx.role, "automations.manage");
  const editable = manage && x.status === "draft";
  const [audiences, events, results] = await Promise.all([
    can(ctx.role, "audiences.read") ? listAudiences(ctx, env.id, { includeArchived: true }) : Promise.resolve([]),
    editable ? knownEvents(ctx, env.id) : Promise.resolve([]),
    x.status === "draft" ? Promise.resolve(null) : experimentResults(ctx, x.id, a.timezone),
  ]);
  const [t, lang] = await Promise.all([getT(), getLang()]);
  const audience = audiences.find((au) => au.id === x.audienceId);
  const base = `/o/${org}/apps/${app}/engage/experiments`;
  const day = (d: Date | null) => (d ? new Date(d).toLocaleDateString(dateLocale(lang), { dateStyle: "medium", timeZone: a.timezone }) : "–");
  const f = x.goal.filter;
  const goalText = f
    ? t("{event} where {property} {op} {value}, within {n} days of first exposure", { event: x.goal.event, property: f.name, op: t(PROPERTY_OP_LABELS[f.op]), value: f.value, n: x.goal.window_days })
    : t("{event} within {n} days of first exposure", { event: x.goal.event, n: x.goal.window_days });
  const r = results;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-ink-3"><Link className="hover:underline" href={`${base}?env=${env.type}`}>{t("Experiments")}</Link> / {t(env.type)}</p>
          <h1 className="h1">{x.name} <ExperimentStatusPill status={x.status} /></h1>
          <p className="mt-1 text-sm text-ink-2">
            <span className="font-mono" dir="ltr">{x.key}</span>
            {x.startedAt && <> · {t("started {date}", { date: day(x.startedAt) })}</>}
            {x.stoppedAt && <> · {t("stopped {date}", { date: day(x.stoppedAt) })}</>}
          </p>
          {x.hypothesis && <p className="mt-2 max-w-2xl text-sm">{x.hypothesis}</p>}
        </div>
        {manage && x.status !== "stopped" && (
          <div className="flex flex-wrap gap-2">
            {/* One form in one place for both steps, so "Running." stays on screen after the page re-renders with the stop button. */}
            {x.status === "draft" ? (
              <ActionForm key="lifecycle" action={experimentLifecycleAction.bind(null, org, app, x.id, "start")} className="space-y-2" submitLabel={t("Start experiment")}
                confirm={t("Start assigning variants? Variants, traffic and the goal can't change after this.")} />
            ) : (
              <ActionForm key="lifecycle" action={experimentLifecycleAction.bind(null, org, app, x.id, "stop")} className="space-y-2" submitLabel={t("Stop experiment")} buttonClass="btn-danger"
                confirm={t("Stop the experiment? Everyone gets your app's default from now on, and it can't be started again.")} />
            )}
          </div>
        )}
      </div>

      {x.status === "draft" && audience && audience.status !== "active" && (
        <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">{t("The audience “{name}” is a draft. Activate it before starting.", { name: audience.name })}</p>
      )}

      {r && (
        <>
          <section className="grid gap-4 sm:grid-cols-3" aria-label={t("Experiment summary")}>
            <div className="card"><p className="text-sm text-ink-3">{t("People exposed")}</p><p className="text-2xl font-semibold tabular-nums">{fmtNumber(r.totalExposed)}</p></div>
            <div className="card"><p className="text-sm text-ink-3">{t("Days running")}</p><p className="text-2xl font-semibold tabular-nums">{fmtNumber(r.days.length)}</p></div>
            <div className="card"><p className="text-sm text-ink-3">{t("Can still convert")}</p><p className="text-2xl font-semibold tabular-nums">{fmtNumber(r.stillInWindow)}</p></div>
          </section>

          {r.srm.mismatch && (
            <p role="alert" className="rounded-lg bg-alert-soft px-3 py-2 text-sm text-alert">
              {t("Sample ratio mismatch: the split of exposed people is far from the weights (chi-square p {p}). Check that every variant sends its exposure event before you trust these results.", { p: pValueText(r.srm.pValue) })}
            </p>
          )}
          {r.totalExposed === 0 ? (
            <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">{t("No one has been exposed yet. Results start when your app sends the {event} event, which getVariant in the JavaScript SDK does for you.", { event: EXPOSURE_EVENT })}</p>
          ) : !r.enough && (
            <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">{t("Not enough data yet. Each variant needs {people} exposed people and {conversions} conversions before the test can tell them apart.", { people: MIN_EXPOSED, conversions: MIN_CONVERSIONS })}</p>
          )}

          <section className="card space-y-3">
            <div>
              <h2 className="h2">{t("Goal")}</h2>
              <p className="text-sm text-ink-2" dir="auto">{goalText}</p>
            </div>
            <MetricTable t={t} variants={r.variants} pick={(v) => v.goal} caption={t("Goal")} />
          </section>

          {x.secondary?.kind === "event" && (
            <section className="card space-y-3">
              <div>
                <h2 className="h2">{t("Secondary metric")}</h2>
                <p className="text-sm text-ink-2">{t("{event} within {n} days of first exposure", { event: x.secondary.event, n: x.goal.window_days })}</p>
              </div>
              <MetricTable t={t} variants={r.variants} pick={(v) => v.secondary!} caption={t("Secondary metric")} />
            </section>
          )}

          {x.secondary?.kind === "revenue" && (
            <section className="card space-y-3">
              <div>
                <h2 className="h2">{t("Revenue per exposed person")}</h2>
                <p className="text-sm text-ink-2">{t("Net revenue within {n} days of first exposure, per currency, with no conversion between currencies. Not tested for significance.", { n: x.goal.window_days })}</p>
              </div>
              {r.currencies.length === 0 ? <p className="text-sm text-ink-3">{t("No revenue from exposed people yet.")}</p> : (
                <div className="overflow-x-auto">
                  <table className="table">
                    <thead><tr><th>{t("Variant")}</th><th>{t("Currency")}</th><th className="text-end">{t("Net revenue")}</th><th className="text-end">{t("Per exposed person")}</th></tr></thead>
                    <tbody>
                      {r.variants.flatMap((v) => (v.revenue ?? []).map((m) => (
                        <tr key={`${v.key}-${m.currency}`}>
                          <td className="font-medium">{v.name}</td>
                          <td className="font-mono text-xs">{m.currency === "(none)" ? t("No currency") : m.currency}</td>
                          <td className="text-end tabular-nums">{fmtNumber(m.net, { maximumFractionDigits: 2 })}</td>
                          <td className="text-end tabular-nums">{fmtNumber(m.perPerson, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                        </tr>
                      )))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          {r.days.length > 0 && (
            <section className="card space-y-2">
              <h2 className="h2">{t("People exposed so far")}</h2>
              <TrendChart days={r.days} series={r.cumulative} label={t("People exposed so far, per variant")} />
              <p className="text-xs text-ink-3">{t("Days in the project's timezone ({timezone}).", { timezone: a.timezone })}</p>
            </section>
          )}

          <section className="card space-y-2 text-sm text-ink-2">
            <h2 className="h2 text-ink">{t("How to read this")}</h2>
            <p>{t("Pick an end date or sample size before you start, and judge the result then. Stopping at the first significant day makes a false winner much more likely.")}</p>
            <p>{r.variants.length > 2
              ? t("Each variant is compared with the control by a two-sided z-test. With {n} variants, a result counts as significant below p {alpha}, so testing several doesn't add false winners.", { n: r.variants.length - 1, alpha: r.alpha.toFixed(3) })
              : t("The variant is compared with the control by a two-sided z-test, significant below p 0.05. Intervals are 95%.")}</p>
            <p>{t("Each person counts once, in the variant of their first exposure, and converts if they do the goal within the window after it.")}{r.switched > 0 ? ` ${t("{n} people were exposed to more than one variant, usually after signing in on a new device.", { n: fmtNumber(r.switched) })}` : ""}</p>
          </section>
        </>
      )}

      <section className="card space-y-2">
        <h2 className="h2">{t("Setup")}</h2>
        <ul className="space-y-1 text-sm">
          {x.variants.map((v, i) => (
            <li key={v.key}><span className="font-medium">{v.name}</span> <span className="font-mono text-xs text-ink-3" dir="ltr">{v.key}</span> · {i === 0 ? t("control") : t("variant")} · {t("weight {n}", { n: v.weight })}</li>
          ))}
        </ul>
        <p className="text-sm text-ink-2">{x.audienceId ? t("Members of {audience}", { audience: audience?.name ?? t("an audience") }) : t("Everyone who opens the app")} · {t("{n}% of them take part", { n: x.trafficPercent })}</p>
        {x.status === "draft" && <p className="text-sm text-ink-2">{t("Goal")}: <span dir="auto">{goalText}</span></p>}
        <p className="text-xs text-ink-3">{t("In your app: Analytics.getVariant(\"{key}\") returns the variant's key, or null when the person isn't in the experiment.", { key: x.key })}</p>
      </section>

      {editable && (
        <section className="card space-y-3">
          <h2 className="h2">{t("Edit")}</h2>
          <ExperimentForm action={saveExperimentAction.bind(null, org, app, env.id, x.id)} initial={formOf(x)} audiences={audiences.filter((au) => au.status !== "archived")} events={events} submitLabel={t("Save")} />
        </section>
      )}
    </div>
  );
}
