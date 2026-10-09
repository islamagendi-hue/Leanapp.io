import Link from "next/link";
import { AcquisitionHeader, AcquisitionRange, num, pct } from "@/components/acquisition/AcquisitionHeader";
import { rangeFromParams, toSearch } from "@/modules/analytics/report-params";
import { attributionOverview, attributionRange } from "@/modules/attribution/reports";
import { getSettings } from "@/modules/attribution/service";
import { skanBySource } from "@/modules/attribution/skan-service";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export const metadata = { title: "Attribution" };

export default async function AttributionPage(props: PageProps<"/o/[org]/apps/[app]/acquisition/attribution">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  requirePermission(ctx, "attribution.read");
  const env = await pickEnvironment(environments, sp.env);
  const r = await attributionOverview(ctx, { environmentId: env.id, timezone: a.timezone }, rangeFromParams(toSearch(sp)));
  const [settings, skan] = await Promise.all([getSettings(ctx, a.id), skanBySource(ctx, env.id, attributionRange(rangeFromParams(toSearch(sp)), a.timezone))]);
  const base = `/o/${org}/apps/${app}/acquisition`;
  const settingsHref = `/o/${org}/apps/${app}/settings/dev-ops/attribution`;
  const t = r.totals;
  const allInstalls = t.installs + t.reinstalls;
  const deterministic = t.attributed - t.probabilistic;

  const rows: [string, number, string][] = [
    ["Deterministic", deterministic, "Matched on a link click id, the store install referrer or an ad-network click id."],
    ["Probabilistic", t.probabilistic, settings.probabilistic_enabled ? `Matched on device signals within ${settings.probabilistic_window_hours} hours of a click.` : "Off for this app."],
    ["Organic", t.organic, "No matching touch within the click lookback."],
    ["Reinstalls", t.reinstalls, "A device that had installed before."],
  ];

  return (
    <div className="space-y-6">
      <AcquisitionHeader base={base} current="/attribution" env={env.type} title="Attribution"
        description="How installs were matched to a touch, the rules used, and Apple's SKAdNetwork postbacks." />
      <AcquisitionRange env={env.type} range={r.range} />

      <section className="card overflow-x-auto p-0" aria-label="How installs were matched">
        <h2 className="h2 px-5 pt-5">How installs were matched</h2>
        <table className="table mt-3">
          <thead><tr><th>Match</th><th className="text-end">Installs</th><th className="text-end">Share</th><th>Meaning</th></tr></thead>
          <tbody>
            {rows.map(([label, value, note]) => (
              <tr key={label}><td className="font-medium">{label}</td><td className="text-end tabular-nums">{num(value)}</td><td className="text-end tabular-nums">{pct(value, allInstalls)}</td><td className="text-sm text-ink-2">{note}</td></tr>
            ))}
          </tbody>
        </table>
        <p className="px-5 pb-5 pt-3 text-sm text-ink-3">
          Also in this range: {num(t.reengagements)} re-engagements (a returning user opening through a tracking link) and {num(t.conversions)} conversions credited by last touch.
        </p>
      </section>

      <section className="card space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="h2">Matching rules</h2>
          <Link className="text-sm underline" href={settingsHref}>Change in Settings → Dev Ops → Attribution</Link>
        </div>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <div><dt className="text-ink-3">Click lookback</dt><dd>{settings.click_lookback_days} days</dd></div>
          <div><dt className="text-ink-3">Conversion window</dt><dd>{settings.conversion_window_days} days</dd></div>
          <div><dt className="text-ink-3">Probabilistic matching</dt><dd>{settings.probabilistic_enabled ? `On, ${settings.probabilistic_window_hours} hours` : "Off"}</dd></div>
          <div><dt className="text-ink-3">Re-engagement</dt><dd>{settings.reengagement_enabled ? "On" : "Off"}</dd></div>
          <div><dt className="text-ink-3">Model</dt><dd>Last touch</dd></div>
        </dl>
      </section>

      <section className="card overflow-x-auto p-0">
        <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 pt-5">
          <h2 className="h2">SKAdNetwork postbacks</h2>
          <Link className="text-sm underline" href={`${settingsHref}/skan`}>SKAdNetwork setup</Link>
        </div>
        <p className="px-5 text-sm text-ink-3">Apple-verified iOS postbacks; aggregate only, never joined to users or counted in the installs above.</p>
        {skan.length === 0 ? <p className="px-5 pb-5 pt-3 text-sm text-ink-3">No postbacks in this range.</p> : (
          <table className="table mt-3">
            <thead><tr><th>Ad network</th><th>Source id</th><th className="text-end">Postbacks</th><th className="text-end">Won</th><th className="text-end">Avg fine value</th><th className="text-end">Coarse high</th></tr></thead>
            <tbody>
              {skan.slice(0, 15).map((k) => (
                <tr key={`${k.framework}:${k.ad_network_id}:${k.source_identifier}`}>
                  <td className="font-mono text-xs">{k.network ?? k.ad_network_id}</td>
                  <td className="font-mono text-xs">{k.source_identifier ?? "–"}</td>
                  <td className="text-end tabular-nums">{num(k.postbacks)}</td>
                  <td className="text-end tabular-nums">{num(k.wins)}</td>
                  <td className="text-end tabular-nums">{k.fine_avg === null ? "–" : k.fine_avg.toFixed(1)}</td>
                  <td className="text-end tabular-nums">{num(k.coarse_high)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card space-y-2 text-sm">
        <h2 className="h2">Not included in the Beta</h2>
        <ul className="list-disc space-y-1 ps-5 text-ink-2">
          <li>Ad cost import, CPI and ROAS</li>
          <li>Fraud prevention</li>
          <li>Multi-touch and view-through attribution</li>
          <li>Installs claimed by ad networks (self-attributing networks) and audience export to them</li>
          <li>Importing history from another attribution provider</li>
        </ul>
      </section>
    </div>
  );
}
