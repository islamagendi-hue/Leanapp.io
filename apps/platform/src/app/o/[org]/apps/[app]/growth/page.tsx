import Link from "next/link";
import { setGrowthModelAction } from "@/app/actions/growth";
import { ActionForm } from "@/components/ActionForm";
import { DefinitionList } from "@/components/GrowthDefinitionList";
import { envName } from "@/components/dashboards/EnvironmentNote";
import { getLang, getT } from "@/i18n/server";
import { dateLocale } from "@/i18n/translate";
import { growthOverview } from "@/modules/growth/service";
import { can } from "@/modules/rbac/authorize";
import { loadApp, pickEnvironment } from "@/server/session";

export async function generateMetadata() {
  return { title: (await getT())("Growth") };
}

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 1000) / 10}%` : "–");
const money = (v: number, c: string) => `${v.toLocaleString("en-GB", { maximumFractionDigits: 2 })} ${c}`;

export default async function GrowthPage(props: PageProps<"/o/[org]/apps/[app]/growth">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  const env = await pickEnvironment(environments, sp.env);
  const o = await growthOverview(ctx, a.id, env.id);
  const [t, lang] = await Promise.all([getT(), getLang()]);
  const base = `/o/${org}/apps/${app}`;
  const canToggle = can(ctx.role, "apps.update");
  const s = o.summary;
  const rebuilding = o.jobs.find((j) => j.kind === "growth_rebuild" && (j.status === "queued" || j.status === "running"));
  const failed = o.jobs.find((j) => j.kind === "growth_rebuild" && j.status === "failed");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="h1">{t("Growth")}</h1>
          <p className="mt-1 text-ink-2">{t("Who activates, keeps coming back and pays, per person, from your own events.")}</p>
        </div>
      </div>

      {!o.enabled && (
        <div className="card space-y-3">
          <p className="max-w-2xl">{t("The growth model is off for this app. Turning it on builds a growth state for every person from all past events, then keeps it current as events arrive. Nothing else changes.")}</p>
          {canToggle ? (
            <ActionForm action={setGrowthModelAction.bind(null, org, app, a.id, true)} submitLabel={t("Turn on the growth model")} className="contents" />
          ) : (
            <p className="text-sm text-ink-3">{t("Ask an owner, admin or developer to turn it on.")}</p>
          )}
        </div>
      )}

      {o.enabled && (rebuilding || failed) && (
        <div className={`rounded-xl border p-4 text-sm ${failed && !rebuilding ? "border-alert/40 bg-alert-soft" : "border-warn/40 bg-warn-soft"}`}>
          {rebuilding ? (
            <p>
              {t("Building growth state ({reason}): {progress}.", {
                reason: t(rebuilding.reason),
                progress: rebuilding.status === "queued"
                  ? t("waiting for the next scheduled run")
                  : t("{done} of about {total} people", { done: rebuilding.done_count.toLocaleString("en-GB"), total: (rebuilding.total_estimate ?? 0).toLocaleString("en-GB") }),
              })}{" "}
              {t("The numbers below may be incomplete until it finishes.")}
            </p>
          ) : (
            <p>{t("The last growth-state build failed: {error}. It will be retried when the definitions change or the model is turned on again.", { error: failed!.last_error ?? "" })}</p>
          )}
        </div>
      )}

      {o.enabled && s && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="card"><p className="font-mono text-xs uppercase tracking-wide text-ink-3">{t("People")}</p><p className="mt-2 text-3xl font-bold">{s.people.toLocaleString("en-GB")}</p></div>
            <div className="card"><p className="font-mono text-xs uppercase tracking-wide text-ink-3">{t("Activated")}</p><p className="mt-2 text-3xl font-bold">{pct(s.activated, s.people)}</p><p className="text-xs text-ink-3">{t("{n} people", { n: s.activated.toLocaleString("en-GB") })}</p></div>
            <div className="card"><p className="font-mono text-xs uppercase tracking-wide text-ink-3">{t("Did the core action")}</p><p className="mt-2 text-3xl font-bold">{pct(s.core_people, s.people)}</p><p className="text-xs text-ink-3">{t("{n} times in all", { n: s.core_actions.toLocaleString("en-GB") })}</p></div>
            <div className="card"><p className="font-mono text-xs uppercase tracking-wide text-ink-3">{t("Paying")}</p><p className="mt-2 text-3xl font-bold">{pct(s.paying, s.people)}</p><p className="text-xs text-ink-3">{t("{n} purchases", { n: s.purchases.toLocaleString("en-GB") })}</p></div>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="card">
              <h2 className="h2">{t("Retention")}</h2>
              <p className="mb-3 text-sm text-ink-3">{t("Share of people who came back on or after day N, among those first seen at least N days ago.")}</p>
              <table className="table">
                <thead><tr><th>{t("Day")}</th><th>{t("Retained")}</th><th>{t("Of")}</th><th>{t("Rate")}</th></tr></thead>
                <tbody>{s.retention.map((r) => <tr key={r.day}><td>D{r.day}</td><td className="font-mono">{r.retained}</td><td className="font-mono">{r.eligible}</td><td className="font-mono">{pct(r.retained, r.eligible)}</td></tr>)}</tbody>
              </table>
            </div>
            <div className="card">
              <h2 className="h2">{t("Revenue")}</h2>
              <p className="mb-3 text-sm text-ink-3">{t("Per currency, never converted.")}</p>
              {s.revenue.length ? (
                <ul className="space-y-1 font-mono text-sm">{s.revenue.map((r) => <li key={r.currency}>{money(r.total, r.currency)}</li>)}</ul>
              ) : <p className="text-sm text-ink-3">{t("No revenue events counted yet.")}</p>}
            </div>
          </div>
          <p className="text-xs text-ink-3">{t("Last updated {when}", { when: o.lastUpdatedAt ? new Date(o.lastUpdatedAt).toLocaleString(dateLocale(lang)) : t("never") })} · {t("{env} environment", { env: envName(env.type, t) })}</p>
        </>
      )}

      <div className="card space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="h2">{t("Definitions")}</h2>
          {can(ctx.role, "implementation.read") && <Link href={`${base}/growth/setup`} className="btn-secondary">{t("Set up growth definitions")}</Link>}
        </div>
        {o.definitions.published ? (
          <>
            <p className="text-sm text-ink-3">
              {o.definitions.published.saved
                ? t("From tracking plan v{version}.", { version: o.definitions.published.version })
                : t("From tracking plan v{version}, derived from its activation and north-star events.", { version: o.definitions.published.version })}
            </p>
            <DefinitionList def={o.definitions.published.definition} />
          </>
        ) : (
          <p className="text-sm text-ink-3">{t("No published tracking plan yet. Until there is one, the growth state only counts activity and retention.")}</p>
        )}
        {o.definitions.draft?.saved && JSON.stringify(o.definitions.draft.definition) !== JSON.stringify(o.definitions.published?.definition) && <p className="text-sm text-warn">{t("Draft v{version} has different definitions waiting for approval.", { version: o.definitions.draft.version })}</p>}
      </div>

      {o.enabled && canToggle && (
        <ActionForm action={setGrowthModelAction.bind(null, org, app, a.id, false)} submitLabel={t("Turn off the growth model")} buttonClass="btn-secondary" className="contents"
          confirm={t("Growth state stops updating. Turning it on again rebuilds it from all events.")} />
      )}
    </div>
  );
}
