import Link from "next/link";
import { setGrowthModelAction } from "@/app/actions/growth";
import { ActionForm } from "@/components/ActionForm";
import { EnvSwitcher } from "@/components/EnvSwitcher";
import { DefinitionList } from "@/components/GrowthDefinitionList";
import { growthOverview } from "@/modules/growth/service";
import { can } from "@/modules/rbac/authorize";
import { loadApp, pickEnvironment } from "@/server/session";

export const metadata = { title: "Growth" };

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 1000) / 10}%` : "–");
const money = (v: number, c: string) => `${v.toLocaleString("en-GB", { maximumFractionDigits: 2 })} ${c}`;

export default async function GrowthPage(props: PageProps<"/o/[org]/apps/[app]/growth">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  const env = pickEnvironment(environments, sp.env);
  const o = await growthOverview(ctx, a.id, env.id);
  const base = `/o/${org}/apps/${app}`;
  const canToggle = can(ctx.role, "apps.update");
  const s = o.summary;
  const rebuilding = o.jobs.find((j) => j.kind === "growth_rebuild" && (j.status === "queued" || j.status === "running"));
  const failed = o.jobs.find((j) => j.kind === "growth_rebuild" && j.status === "failed");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="h1">Growth</h1>
          <p className="mt-1 text-ink-2">Who activates, keeps coming back and pays, per person, from your own events.</p>
        </div>
        {o.enabled && <EnvSwitcher path={`${base}/growth`} current={env.type} />}
      </div>

      {!o.enabled && (
        <div className="card space-y-3">
          <p>The growth model is off for this app. Turning it on builds a growth state for every person from all past events, then keeps it current as events arrive. Nothing else changes.</p>
          {canToggle ? (
            <ActionForm action={setGrowthModelAction.bind(null, org, app, a.id, true)} submitLabel="Turn on the growth model" className="contents" />
          ) : (
            <p className="text-sm text-ink-3">Ask an owner, admin or developer to turn it on.</p>
          )}
        </div>
      )}

      {o.enabled && (rebuilding || failed) && (
        <div className={`rounded-xl border p-4 text-sm ${failed && !rebuilding ? "border-alert/40 bg-alert-soft" : "border-warn/40 bg-warn-soft"}`}>
          {rebuilding ? (
            <p>
              Building growth state ({rebuilding.reason}): {rebuilding.status === "queued" ? "waiting for the next scheduled run" : `${rebuilding.done_count.toLocaleString("en-GB")} of about ${(rebuilding.total_estimate ?? 0).toLocaleString("en-GB")} people`}.
              The numbers below may be incomplete until it finishes.
            </p>
          ) : (
            <p>The last growth-state build failed: {failed!.last_error}. It will be retried when the definitions change or the model is turned on again.</p>
          )}
        </div>
      )}

      {o.enabled && s && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="card"><p className="font-mono text-xs uppercase tracking-wide text-ink-3">People</p><p className="mt-2 text-3xl font-bold">{s.people.toLocaleString("en-GB")}</p></div>
            <div className="card"><p className="font-mono text-xs uppercase tracking-wide text-ink-3">Activated</p><p className="mt-2 text-3xl font-bold">{pct(s.activated, s.people)}</p><p className="text-xs text-ink-3">{s.activated.toLocaleString("en-GB")} people</p></div>
            <div className="card"><p className="font-mono text-xs uppercase tracking-wide text-ink-3">Did the core action</p><p className="mt-2 text-3xl font-bold">{pct(s.core_people, s.people)}</p><p className="text-xs text-ink-3">{s.core_actions.toLocaleString("en-GB")} times in all</p></div>
            <div className="card"><p className="font-mono text-xs uppercase tracking-wide text-ink-3">Paying</p><p className="mt-2 text-3xl font-bold">{pct(s.paying, s.people)}</p><p className="text-xs text-ink-3">{s.purchases.toLocaleString("en-GB")} purchases</p></div>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="card">
              <h2 className="h2">Retention</h2>
              <p className="mb-3 text-sm text-ink-3">Share of people who came back on or after day N, among those first seen at least N days ago.</p>
              <table className="table">
                <thead><tr><th>Day</th><th>Retained</th><th>Of</th><th>Rate</th></tr></thead>
                <tbody>{s.retention.map((r) => <tr key={r.day}><td>D{r.day}</td><td className="font-mono">{r.retained}</td><td className="font-mono">{r.eligible}</td><td className="font-mono">{pct(r.retained, r.eligible)}</td></tr>)}</tbody>
              </table>
            </div>
            <div className="card">
              <h2 className="h2">Revenue</h2>
              <p className="mb-3 text-sm text-ink-3">Per currency, never converted.</p>
              {s.revenue.length ? (
                <ul className="space-y-1 font-mono text-sm">{s.revenue.map((r) => <li key={r.currency}>{money(r.total, r.currency)}</li>)}</ul>
              ) : <p className="text-sm text-ink-3">No revenue events counted yet.</p>}
            </div>
          </div>
          <p className="text-xs text-ink-3">Last updated {o.lastUpdatedAt ? new Date(o.lastUpdatedAt).toLocaleString("en-GB") : "never"} · {env.type} environment</p>
        </>
      )}

      <div className="card space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="h2">Definitions</h2>
          <Link href={`${base}/growth/setup`} className="btn-secondary">Set up growth definitions</Link>
        </div>
        {o.definitions.published ? (
          <>
            <p className="text-sm text-ink-3">
              From tracking plan v{o.definitions.published.version}{o.definitions.published.saved ? "" : ", derived from its activation and north-star events"}.
            </p>
            <DefinitionList def={o.definitions.published.definition} />
          </>
        ) : (
          <p className="text-sm text-ink-3">No published tracking plan yet. Until there is one, the growth state only counts activity and retention.</p>
        )}
        {o.definitions.draft?.saved && JSON.stringify(o.definitions.draft.definition) !== JSON.stringify(o.definitions.published?.definition) && <p className="text-sm text-warn">Draft v{o.definitions.draft.version} has different definitions waiting for approval.</p>}
      </div>

      {o.enabled && canToggle && (
        <ActionForm action={setGrowthModelAction.bind(null, org, app, a.id, false)} submitLabel="Turn off the growth model" buttonClass="btn-secondary" className="contents"
          confirm="Growth state stops updating. Turning it on again rebuilds it from all events." />
      )}
    </div>
  );
}
