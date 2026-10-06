import Link from "next/link";
import { CodeTabs } from "@/components/CodeTabs";
import { EnvSwitcher } from "@/components/EnvSwitcher";
import { TrendChart } from "@/components/TrendChart";
import { consentOverview, lookupConsent, PURPOSES, type ConsentDecision, type ConsentLookup, type Purpose } from "@/modules/privacy/consent";
import { AppError } from "@/lib/errors";
import { publicBaseUrl } from "@/server/env";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export const metadata = { title: "Consent" };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
const fmt = (d: Date | null) => (d ? new Date(d).toLocaleString("en-GB") : "–");
const num = (n: number) => n.toLocaleString("en-US");
const RANGES = [7, 30, 90];

function Decision({ v }: { v: ConsentDecision }) {
  if (v === true) return <span className="pill border-accent/40 text-accent-ink">granted</span>;
  if (v === false) return <span className="pill border-alert/40 text-alert">denied</span>;
  return <span className="pill border-line text-ink-3">no decision</span>;
}

export default async function ConsentPage(props: PageProps<"/o/[org]/apps/[app]/privacy/consent">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, environments } = await loadApp(org, app);
  requirePermission(ctx, "privacy.manage");
  const env = pickEnvironment(environments, sp.env);
  const days = RANGES.includes(Number(one(sp.days))) ? Number(one(sp.days)) : 30;
  const purpose: Purpose = (PURPOSES as readonly string[]).includes(one(sp.purpose) ?? "") ? (one(sp.purpose) as Purpose) : "analytics";
  const points = await consentOverview(ctx, env.id, days);
  const userId = one(sp.user_id);
  const anonymousId = one(sp.anonymous_id);
  let lookup: ConsentLookup | null = null;
  let lookupError: string | null = null;
  if (userId || anonymousId) {
    try {
      lookup = await lookupConsent({ kind: "user", ctx }, env.id, { userId, anonymousId });
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      lookupError = err.message;
    }
  }
  const base = `/o/${org}/apps/${app}/privacy/consent`;
  const dayList = [...new Set(points.map((p) => p.day))];
  const of = (p: Purpose) => points.filter((x) => x.purpose === p);
  const latest = (p: Purpose) => of(p).at(-1) ?? { granted: 0, denied: 0, pending: 0 };
  const selected = of(purpose);
  const api = publicBaseUrl();
  const href = (q: Record<string, string>) => `${base}?${new URLSearchParams({ env: env.type, days: String(days), purpose, ...q })}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="h1">Consent</h1>
          <p className="mt-1 max-w-2xl text-ink-2">
            What your app&apos;s users agreed to, per purpose. Events from anyone who denied analytics are not stored; denied marketing or push puts them on the{" "}
            <Link className="underline" href={`/o/${org}/apps/${app}/privacy/suppressions?env=${env.type}`}>suppression list</Link>.
          </p>
        </div>
        <EnvSwitcher path={base} current={env.type} query={sp} />
      </div>

      <section className="card space-y-3">
        <h2 className="h2">Today</h2>
        <div className="overflow-x-auto">
          <table className="table">
            <thead><tr><th>Purpose</th><th className="text-end">Granted</th><th className="text-end">Denied</th><th className="text-end">No decision</th><th /></tr></thead>
            <tbody>
              {PURPOSES.map((p) => {
                const l = latest(p);
                return (
                  <tr key={p}>
                    <td className="font-medium capitalize">{p}</td>
                    <td className="text-end tabular-nums">{num(l.granted)}</td>
                    <td className="text-end tabular-nums">{num(l.denied)}</td>
                    <td className="text-end tabular-nums text-ink-3">{num(l.pending)}</td>
                    <td className="text-end"><Link className="text-sm underline" href={href({ purpose: p })}>{p === purpose ? "Shown below" : "Show trend"}</Link></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-ink-3">
          Counted per install by its latest decision (per user for changes your backend sent without an anonymous ID). &quot;No decision&quot; is installs that sent events but no consent for that purpose; apps that wait for consent before sending anything don&apos;t appear until the user decides.
        </p>
      </section>

      <section className="card space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 className="h2 capitalize">{purpose} consent over time</h2>
          <div className="flex gap-2 text-sm">
            {RANGES.map((r) => (
              <Link key={r} href={href({ days: String(r) })} className={`rounded-md px-2 py-1 ${r === days ? "bg-ink text-paper" : "text-ink-2 hover:bg-paper-2"}`}>{r} days</Link>
            ))}
          </div>
        </div>
        {selected.every((p) => !p.granted && !p.denied && !p.pending) ? (
          <p className="text-sm text-ink-3">No consent recorded in this environment yet. Call <code className="font-mono">Analytics.setConsent()</code> from your consent screen.</p>
        ) : (
          <TrendChart
            days={dayList}
            label={`${purpose} consent per day`}
            series={[
              { key: "Granted", counts: selected.map((p) => p.granted) },
              { key: "Denied", counts: selected.map((p) => p.denied) },
              { key: "No decision", counts: selected.map((p) => p.pending) },
            ]}
          />
        )}
      </section>

      <section className="card space-y-4">
        <h2 className="h2">Look up a user</h2>
        <form method="get" className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="env" value={env.type} />
          <input type="hidden" name="days" value={days} />
          <input type="hidden" name="purpose" value={purpose} />
          <label className="min-w-48 flex-1"><span className="label">User ID</span><input name="user_id" className="input" maxLength={256} defaultValue={userId ?? ""} /></label>
          <label className="min-w-48 flex-1"><span className="label">Anonymous ID</span><input name="anonymous_id" className="input" maxLength={256} defaultValue={anonymousId ?? ""} /></label>
          <button className="btn-secondary" type="submit">Look up</button>
        </form>
        {lookupError && <p className="rounded-lg bg-alert-soft px-3 py-2 text-sm text-alert" role="alert">{lookupError}</p>}
        {lookup && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
              {PURPOSES.map((p) => (
                <div key={p} className="flex items-center gap-2"><span className="capitalize text-ink-2">{p}</span><Decision v={lookup.state[p]} /></div>
              ))}
            </div>
            <p className="text-xs text-ink-3">
              Keys: <span className="font-mono">{lookup.keys.join(", ")}</span>. The most recent decision under any of them applies. Last change {fmt(lookup.state.updatedAt)}.
            </p>
            {lookup.suppressions.length > 0 && (
              <p className="text-sm">
                Suppressed for:{" "}
                {lookup.suppressions.map((s) => <span key={s.id} className="pill me-1 border-line">{s.channel} · {s.source}</span>)}
              </p>
            )}
            {lookup.history.length === 0 ? (
              <p className="text-sm text-ink-3">No consent recorded for this user in the {env.type} environment.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="table">
                  <thead><tr><th>Decided</th><th>Purpose</th><th>Decision</th><th>Source</th><th>IDs</th></tr></thead>
                  <tbody>
                    {lookup.history.map((h, i) => (
                      <tr key={i}>
                        <td className="whitespace-nowrap text-ink-3">{fmt(h.recorded_at)}</td>
                        <td className="capitalize">{h.purpose}</td>
                        <td><Decision v={h.granted} /></td>
                        <td>{h.source}</td>
                        <td className="font-mono text-xs break-all">
                          {h.user_id && <div>user: {h.user_id}</div>}
                          {h.anonymous_id && <div>anon: {h.anonymous_id}</div>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </section>

      <section className="card space-y-3">
        <h2 className="h2">Recording consent</h2>
        <p className="text-sm text-ink-3">
          From the app, call <code className="font-mono">setConsent</code> when the user answers your consent screen; the SDK stores the answer, sends it here and holds or drops events accordingly. From a server, send a <code className="font-mono">consent</code> event with a secret key.
        </p>
        <CodeTabs
          preferred="sdk"
          tabs={[
            {
              key: "sdk",
              label: "SDK",
              code: `Analytics.initialize({ apiKey: "la_pk_…", consentDefault: "pending" }); // wait for the user's answer
Analytics.setConsent({ analytics: true, marketing: false, push: true, attribution: true });`,
            },
            {
              key: "api",
              label: "Server",
              code: `curl -X POST ${api}/v1/events \\
  -H "Authorization: Bearer $LEANAPP_SECRET_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"type":"consent","user_id":"user_123","event_id":"consent-user_123-1","consent":{"marketing":false}}'`,
            },
          ]}
        />
      </section>
    </div>
  );
}
