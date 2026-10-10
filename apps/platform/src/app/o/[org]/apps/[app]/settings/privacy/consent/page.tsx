import Link from "next/link";
import { CodeTabs } from "@/components/CodeTabs";
import { TrendChart } from "@/components/TrendChart";
import { consentOverview, lookupConsent, PURPOSES, type ConsentDecision, type ConsentLookup, type Purpose } from "@/modules/privacy/consent";
import { getLang, getT } from "@/i18n/server";
import { dateLocale, msg, type Lang, type T } from "@/i18n/translate";
import { AppError } from "@/lib/errors";
import { publicBaseUrl } from "@/server/env";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export async function generateMetadata() {
  const t = await getT();
  return { title: t("Consent") };
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
const fmt = (d: Date | null, lang: Lang) => (d ? new Date(d).toLocaleString(dateLocale(lang)) : "–");
const ENV_LABEL: Record<string, string> = { development: msg("Development"), staging: msg("Staging"), production: msg("Production") };
// Raw values as English labels (shown capitalized by CSS); product names (sdk, api, whatsapp) stay as they are.
const PURPOSE_LABEL: Record<Purpose, string> = { analytics: msg("analytics"), marketing: msg("marketing"), push: msg("push"), attribution: msg("attribution") };
const SOURCE_LABEL: Record<string, string> = { dashboard: msg("dashboard") };
const CHANNEL_LABEL: Record<string, string> = { marketing: msg("marketing"), push: msg("push"), email: msg("email") };
const SUPPRESSION_SOURCE: Record<string, string> = { manual: msg("manual"), consent: msg("consent"), unsubscribe: msg("unsubscribe") };
const num = (n: number) => n.toLocaleString("en-US");
const RANGES = [7, 30, 90];

function Decision({ v, t }: { v: ConsentDecision; t: T }) {
  if (v === true) return <span className="pill border-accent/40 text-accent-ink">{t("granted")}</span>;
  if (v === false) return <span className="pill border-alert/40 text-alert">{t("denied")}</span>;
  return <span className="pill border-line text-ink-3">{t("no decision")}</span>;
}

export default async function ConsentPage(props: PageProps<"/o/[org]/apps/[app]/settings/privacy/consent">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const [t, lang] = await Promise.all([getT(), getLang()]);
  const { ctx, environments } = await loadApp(org, app);
  requirePermission(ctx, "privacy.manage");
  const env = await pickEnvironment(environments, sp.env);
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
      lookupError = t(err.message);
    }
  }
  const base = `/o/${org}/apps/${app}/settings/privacy/consent`;
  const dayList = [...new Set(points.map((p) => p.day))];
  const of = (p: Purpose) => points.filter((x) => x.purpose === p);
  const latest = (p: Purpose) => of(p).at(-1) ?? { granted: 0, denied: 0, pending: 0 };
  const selected = of(purpose);
  const api = publicBaseUrl();
  // One sentence with the link in its place, so it reads naturally in both languages.
  const intro = t("What your app's users agreed to, per purpose. Events from anyone who denied analytics are not stored; denied marketing or push puts them on the {link}.").split("{link}");
  const href = (q: Record<string, string>) => `${base}?${new URLSearchParams({ env: env.type, days: String(days), purpose, ...q })}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="h1">{t("Consent")}</h1>
          <p className="mt-1 max-w-2xl text-ink-2">
            {intro[0]}
            <Link className="underline" href={`/o/${org}/apps/${app}/settings/privacy/suppressions?env=${env.type}`}>{t("suppression list")}</Link>
            {intro[1]}
          </p>
        </div>
      </div>

      <section className="card space-y-3">
        <h2 className="h2">{t("Today")}</h2>
        <div className="overflow-x-auto">
          <table className="table">
            <thead><tr><th>{t("Purpose")}</th><th className="text-end">{t("Granted")}</th><th className="text-end">{t("Denied")}</th><th className="text-end">{t("No decision")}</th><th /></tr></thead>
            <tbody>
              {PURPOSES.map((p) => {
                const l = latest(p);
                return (
                  <tr key={p}>
                    <td className="font-medium capitalize">{t(PURPOSE_LABEL[p])}</td>
                    <td className="text-end tabular-nums">{num(l.granted)}</td>
                    <td className="text-end tabular-nums">{num(l.denied)}</td>
                    <td className="text-end tabular-nums text-ink-3">{num(l.pending)}</td>
                    <td className="text-end"><Link className="text-sm underline" href={href({ purpose: p })}>{p === purpose ? t("Shown below") : t("Show trend")}</Link></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-ink-3">
          {t('Counted per install by its latest decision (per user for changes your backend sent without an anonymous ID). "No decision" is installs that sent events but no consent for that purpose; apps that wait for consent before sending anything don\'t appear until the user decides.')}
        </p>
      </section>

      <section className="card space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 className="h2 capitalize">{t("{purpose} consent over time", { purpose: t(PURPOSE_LABEL[purpose]) })}</h2>
          <div className="flex gap-2 text-sm">
            {RANGES.map((r) => (
              <Link key={r} href={href({ days: String(r) })} className={`rounded-md px-2 py-1 ${r === days ? "bg-ink text-paper" : "text-ink-2 hover:bg-paper-2"}`}>{t("{n} days", { n: r })}</Link>
            ))}
          </div>
        </div>
        {selected.every((p) => !p.granted && !p.denied && !p.pending) ? (
          <p className="text-sm text-ink-3">{t("No consent recorded in this environment yet. Call {code} from your consent screen.", { code: "Analytics.setConsent()" })}</p>
        ) : (
          <TrendChart
            days={dayList}
            label={t("{purpose} consent per day", { purpose: t(PURPOSE_LABEL[purpose]) })}
            series={[
              { key: "Granted", counts: selected.map((p) => p.granted) },
              { key: "Denied", counts: selected.map((p) => p.denied) },
              { key: "No decision", counts: selected.map((p) => p.pending) },
            ]}
          />
        )}
      </section>

      <section className="card space-y-4">
        <h2 className="h2">{t("Look up a user")}</h2>
        <form method="get" className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="env" value={env.type} />
          <input type="hidden" name="days" value={days} />
          <input type="hidden" name="purpose" value={purpose} />
          <label className="min-w-48 flex-1"><span className="label">{t("User ID")}</span><input name="user_id" className="input" maxLength={256} defaultValue={userId ?? ""} /></label>
          <label className="min-w-48 flex-1"><span className="label">{t("Anonymous ID")}</span><input name="anonymous_id" className="input" maxLength={256} defaultValue={anonymousId ?? ""} /></label>
          <button className="btn-secondary" type="submit">{t("Look up")}</button>
        </form>
        {lookupError && <p className="rounded-lg bg-alert-soft px-3 py-2 text-sm text-alert" role="alert">{lookupError}</p>}
        {lookup && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
              {PURPOSES.map((p) => (
                <div key={p} className="flex items-center gap-2"><span className="capitalize text-ink-2">{t(PURPOSE_LABEL[p])}</span><Decision v={lookup.state[p]} t={t} /></div>
              ))}
            </div>
            <p className="text-xs text-ink-3">
              {t("Keys:")} <span dir="ltr" className="font-mono">{lookup.keys.join(", ")}</span>. {t("The most recent decision under any of them applies. Last change {date}.", { date: fmt(lookup.state.updatedAt, lang) })}
            </p>
            {lookup.suppressions.length > 0 && (
              <p className="text-sm">
                {t("Suppressed for:")}{" "}
                {lookup.suppressions.map((s) => <span key={s.id} className="pill me-1 border-line">{t(CHANNEL_LABEL[s.channel] ?? s.channel)} · {t(SUPPRESSION_SOURCE[s.source] ?? s.source)}</span>)}
              </p>
            )}
            {lookup.history.length === 0 ? (
              <p className="text-sm text-ink-3">{t("No consent recorded for this user in the {env} environment.", { env: t(ENV_LABEL[env.type] ?? env.type) })}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="table">
                  <thead><tr><th>{t("Decided")}</th><th>{t("Purpose")}</th><th>{t("Decision")}</th><th>{t("Source")}</th><th>{t("IDs")}</th></tr></thead>
                  <tbody>
                    {lookup.history.map((h, i) => (
                      <tr key={i}>
                        <td className="whitespace-nowrap text-ink-3">{fmt(h.recorded_at, lang)}</td>
                        <td className="capitalize">{t(PURPOSE_LABEL[h.purpose] ?? h.purpose)}</td>
                        <td><Decision v={h.granted} t={t} /></td>
                        <td>{t(SOURCE_LABEL[h.source] ?? h.source)}</td>
                        <td dir="ltr" className="font-mono text-xs break-all">
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
        <h2 className="h2">{t("Recording consent")}</h2>
        <p className="text-sm text-ink-3">
          {t("From the app, call {setConsent} when the user answers your consent screen; the SDK stores the answer, sends it here and holds or drops events accordingly. From a server, send a {consent} event with a secret key.", { setConsent: "setConsent", consent: "consent" })}
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
              label: t("Server"),
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
