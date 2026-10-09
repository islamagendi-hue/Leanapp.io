import Link from "next/link";
import { AcquisitionHeader, AcquisitionRange, num, pct } from "@/components/acquisition/AcquisitionHeader";
import { rangeFromParams, toSearch } from "@/modules/analytics/report-params";
import { attributionOverview, attributionRange } from "@/modules/attribution/reports";
import { getSettings } from "@/modules/attribution/service";
import { skanBySource } from "@/modules/attribution/skan-service";
import { getT } from "@/i18n/server";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export async function generateMetadata() {
  return { title: (await getT())("Attribution") };
}

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
  const tr = await getT();
  const t = r.totals;
  const allInstalls = t.installs + t.reinstalls;

  const rows: [string, number, string][] = [
    [tr("Deterministic"), t.deterministic, tr("Matched to a click LeanApp's own tracking link recorded: its click id came back in the Play install referrer, a deep link or the SDK, or the click carried the same ad-network click id.")],
    [tr("Reported"), t.reported, tr("Only the install says where it came from: an ad-network click id or UTM parameters with no recorded click behind them. Not verified by LeanApp.")],
    [tr("Probabilistic"), t.probabilistic, settings.probabilistic_enabled ? tr("Matched on device signals within {hours} hours of a click.", { hours: settings.probabilistic_window_hours }) : tr("Off for this app.")],
    [tr("Organic (store referrer)"), t.organic_store, tr("The store's own install referrer said organic (Google Play: utm_medium=organic). Observed, not matched to a click.")],
    [tr("Direct"), t.direct, tr("The install's parameters said direct or none.")],
    [tr("Unknown source"), t.organic_unknown, tr("Marked organic by a source no rule recognises.")],
    [tr("Unattributed"), t.unattributed, tr("Nothing observed or matched within the click lookback. Includes paid iOS installs that carried no LeanApp click id. Never counted as organic.")],
    [tr("Reinstalls"), t.reinstalls, tr("A device that had installed before.")],
  ];

  return (
    <div className="space-y-6">
      <AcquisitionHeader base={base} current="/attribution" env={env.type} title={tr("Attribution")}
        description={tr("How installs were matched to a touch, the rules used, and Apple's SKAdNetwork postbacks.")} />
      <AcquisitionRange env={env.type} range={r.range} />

      <section className="card overflow-x-auto p-0" aria-label={tr("How installs were matched")}>
        <h2 className="h2 px-5 pt-5">{tr("How installs were matched")}</h2>
        <table className="table mt-3">
          <thead><tr><th className="min-w-28">{tr("Match")}</th><th className="text-end">{tr("Installs")}</th><th className="text-end">{tr("Share")}</th><th className="min-w-64">{tr("Meaning")}</th></tr></thead>
          <tbody>
            {rows.map(([label, value, note]) => (
              <tr key={label}><td className="font-medium">{label}</td><td className="text-end tabular-nums">{num(value)}</td><td className="text-end tabular-nums">{pct(value, allInstalls)}</td><td className="text-sm text-ink-2">{note}</td></tr>
            ))}
          </tbody>
        </table>
        <p className="px-5 pt-3 text-sm text-ink-2" data-testid="ios-attribution-note">
          {tr("iOS: paid installs from ad networks can't be attributed deterministically without SKAdNetwork / AdAttributionKit or Apple Search Ads, and LeanApp never fingerprints iOS devices. Unless the install brings back a LeanApp click id, an iOS install counts as unattributed ({n} in this range, all no-match iOS installs). Apple's aggregate postbacks are listed under SKAdNetwork postbacks below.", { n: num(t.organic_ios) })}
        </p>
        <p className="px-5 pb-5 pt-3 text-sm text-ink-3">
          {tr("Also in this range: {reengagements} re-engagements (users back via a tracking link) and {conversions} last-touch conversions.", { reengagements: num(t.reengagements), conversions: num(t.conversions) })}
        </p>
      </section>

      <section className="card space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="h2">{tr("Matching rules")}</h2>
          <Link className="text-sm underline" href={settingsHref}>{tr("Change in Settings → Dev Ops → Attribution")}</Link>
        </div>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <div><dt className="text-ink-3">{tr("Click lookback")}</dt><dd>{tr("{n} days", { n: settings.click_lookback_days })}</dd></div>
          <div><dt className="text-ink-3">{tr("Conversion window")}</dt><dd>{tr("{n} days", { n: settings.conversion_window_days })}</dd></div>
          <div><dt className="text-ink-3">{tr("Probabilistic matching")}</dt><dd>{settings.probabilistic_enabled ? tr("On, {hours} hours", { hours: settings.probabilistic_window_hours }) : tr("Off")}</dd></div>
          <div><dt className="text-ink-3">{tr("Re-engagement")}</dt><dd>{settings.reengagement_enabled ? tr("On") : tr("Off")}</dd></div>
          <div><dt className="text-ink-3">{tr("Reports open with")}</dt><dd>{settings.reporting_model === "first_touch" ? tr("First touch") : tr("Last touch")}</dd></div>
          <div><dt className="text-ink-3">{tr("Credit models")}</dt><dd>{tr("Last touch and first touch, both within the conversion window")}</dd></div>
        </dl>
      </section>

      <section className="card overflow-x-auto p-0">
        <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 pt-5">
          <h2 className="h2">{tr("SKAdNetwork postbacks")}</h2>
          <Link className="text-sm underline" href={`${settingsHref}/skan`}>{tr("SKAdNetwork setup")}</Link>
        </div>
        <p className="px-5 text-sm text-ink-3">{tr("Apple-verified iOS postbacks; aggregate only, never joined to users or counted in the installs above.")}</p>
        {skan.length === 0 ? <p className="px-5 pb-5 pt-3 text-sm text-ink-3">{tr("No postbacks in this range.")}</p> : (
          <table className="table mt-3">
            <thead><tr><th>{tr("Ad network")}</th><th>{tr("Source id")}</th><th className="text-end">{tr("Postbacks")}</th><th className="text-end">{tr("Won")}</th><th className="text-end">{tr("Avg fine value")}</th><th className="text-end">{tr("Coarse high")}</th></tr></thead>
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

      <section className="card space-y-2 text-sm" data-testid="evidence-labels">
        <h2 className="h2">{tr("What each number rests on")}</h2>
        <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
          <div><dt className="font-medium">{tr("Deterministic match")}</dt><dd className="text-ink-2">{tr("A click id came back and matches a click LeanApp's own link recorded.")}</dd></div>
          <div><dt className="font-medium">{tr("Observed")}</dt><dd className="text-ink-2">{tr("LeanApp saw campaign parameters or a store referrer on the install or open, but no recorded click verifies them.")}</dd></div>
          <div><dt className="font-medium">{tr("Provider-reported")}</dt><dd className="text-ink-2">{tr("A provider says so in aggregate, such as SKAdNetwork postbacks. Shown separately, never added to LeanApp's counts.")}</dd></div>
          <div><dt className="font-medium">{tr("Modeled")}</dt><dd className="text-ink-2">{tr("Inferred: the opt-in Android match on network address and OS version.")}</dd></div>
        </dl>
        <p className="text-ink-3">{tr("UTM parameters alone never make a mobile install deterministic: they say where the person says they came from. On iOS, Universal Links and deferred deep links only carry a click id when the app passes it on.")}</p>
      </section>

      <section className="card space-y-2 text-sm">
        <h2 className="h2">{tr("Not included in the Beta")}</h2>
        <ul className="list-disc space-y-1 ps-5 text-ink-2">
          <li>{tr("Automatic import of ad cost, and CPI")}</li>
          <li>{tr("Fraud prevention")}</li>
          <li>{tr("Multi-touch and view-through attribution")}</li>
          <li>{tr("Installs claimed by ad networks (self-attributing networks) and audience export to them")}</li>
          <li>{tr("Importing history from other providers")}</li>
        </ul>
      </section>
    </div>
  );
}
