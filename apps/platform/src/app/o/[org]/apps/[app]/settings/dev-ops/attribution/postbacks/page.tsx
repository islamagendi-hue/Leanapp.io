import Link from "next/link";
import { createPostbackAction, setPostbackStatusAction } from "@/app/actions/attribution";
import { param } from "@/components/AnalyticsHeader";
import { ActionForm } from "@/components/ActionForm";
import { encryptionAvailable } from "@/lib/secret-box";
import { NETWORK_SPECS, NETWORKS, type Network } from "@/modules/attribution/networks";
import { POSTBACK_MACROS } from "@/modules/attribution/pure";
import { listPostbacks } from "@/modules/attribution/service";
import { can } from "@/modules/rbac/authorize";
import { rich, envName, statusName } from "@/components/acquisition/rich";
import { getLang, getT } from "@/i18n/server";
import { dateLocale, msg, type Lang } from "@/i18n/translate";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export async function generateMetadata() {
  return { title: (await getT())("Postbacks") };
}

/** Why a delivery was skipped (modules/attribution/conversions.ts). */
const SKIP_REASONS: Record<string, string> = {
  consent_denied: msg("Not sent: the user denied attribution consent."),
  no_match_key: msg("Not sent: nothing the network can match on (no click id or install id)."),
  invalid_payload: msg("Not sent: the event breaks the network's rules:"),
};

const fmt = (d: Date | null, lang: Lang) => (d ? new Date(d).toLocaleString(dateLocale(lang)) : "–");

export default async function PostbacksPage(props: PageProps<"/o/[org]/apps/[app]/settings/dev-ops/attribution/postbacks">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  requirePermission(ctx, "attribution.read");
  const env = await pickEnvironment(environments, sp.env);
  const { postbacks, deliveries } = await listPostbacks(ctx, a.id, env.id);
  const manage = can(ctx.role, "attribution.manage");
  const base = `/o/${org}/apps/${app}/settings/dev-ops/attribution/postbacks`;
  const requested = param(sp.network);
  const network: Network = (NETWORKS as readonly string[]).includes(requested ?? "") ? (requested as Network) : "custom";
  const spec = NETWORK_SPECS[network];
  const canEncrypt = encryptionAvailable();
  const [t, lang] = await Promise.all([getT(), getLang()]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="h1">{t("Postbacks")}</h1>
          <p className="mt-1 max-w-2xl text-ink-2">
            {t("Tell ad networks and your own systems about the installs and conversions they drove. Deliveries are queued as events are processed and sent by the scheduled worker, with retries (1 min → 12 h) on errors.")}
          </p>
        </div>
      </div>

      <section className="card overflow-x-auto p-0">
        {postbacks.length === 0 ? (
          <p className="p-5 text-sm text-ink-3">{t("No postbacks in {env}.", { env: envName(t, env.type) })}</p>
        ) : (
          <table className="table">
            <thead><tr><th>{t("Postback")}</th><th>{t("Events")}</th><th>{t("Status")}</th><th className="text-end">{t("Sent")}</th><th className="text-end">{t("Queued")}</th><th className="text-end">{t("Failed")}</th><th></th></tr></thead>
            <tbody>
              {postbacks.map((p) => (
                <tr key={p.id}>
                  <td>
                    <div className="font-medium">{p.name}</div>
                    <div className="text-xs text-ink-3">
                      {t(NETWORK_SPECS[p.network].label)}
                      {!NETWORK_SPECS[p.network].verified && <span className="pill ms-2 border-warn/40 text-warn">{t("not verified with the live network")}</span>}
                    </div>
                    {NETWORK_SPECS[p.network].config.filter((f) => f.options && p.config[f.key] && p.config[f.key] !== f.options[0].value).map((f) => (
                      <div key={f.key} className="text-xs text-ink-2">{t(f.label)}: {t(f.options!.find((o) => o.value === p.config[f.key])?.label ?? p.config[f.key])}</div>
                    ))}
                    {p.config.test_event_code && <div className="text-xs text-warn">{t("Test event code set: Meta shows these events under Test events only.")}</div>}
                    {p.url_template && <code className="mt-1 block font-mono text-xs break-all text-ink-2" dir="ltr">{p.http_method} {p.url_template}</code>}
                    {p.network !== "custom" && !p.has_credentials && <div className="text-xs text-alert">{t("Not connected: no credentials stored.")}</div>}
                  </td>
                  <td className="font-mono text-xs">
                    {p.events.join(", ")}
                    {p.sources.length > 0 && <div className="text-ink-3">{t("sources: {list}", { list: p.sources.join(", ") })}</div>}
                    {p.include_organic && <div className="text-ink-3">{t("+ organic")}</div>}
                  </td>
                  <td>{statusName(t, p.status)}</td>
                  <td className="text-end tabular-nums">{p.succeeded}</td>
                  <td className="text-end tabular-nums">{p.pending}</td>
                  <td className="text-end tabular-nums">{p.failed}</td>
                  <td className="space-y-1">
                    {manage && (
                      <>
                        <ActionForm action={setPostbackStatusAction.bind(null, org, app, p.id, p.status === "active" ? "paused" : "active")} submitLabel={p.status === "active" ? t("Pause") : t("Resume")} buttonClass="btn-secondary min-h-8 px-3" className="" />
                        <ActionForm action={setPostbackStatusAction.bind(null, org, app, p.id, "deleted")} submitLabel={t("Delete")} buttonClass="btn-danger" className="" confirm={t("Delete this postback and its delivery history?")} />
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {manage && (
        <section className="card space-y-4">
          <h2 className="h2">{t("New postback")}</h2>
          <nav className="flex flex-wrap gap-2 text-sm" aria-label={t("Network")}>
            {NETWORKS.map((n) => (
              <Link key={n} href={`${base}?${new URLSearchParams({ env: env.type, network: n })}`} className={`rounded-md border px-3 py-1.5 ${n === network ? "border-ink bg-ink text-paper" : "border-line text-ink-2 hover:bg-paper-2"}`}>
                {t(NETWORK_SPECS[n].label)}
              </Link>
            ))}
          </nav>
          {!spec.verified && (
            <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
              {rich(t("The {network} integration follows the network's published API but is {notVerified} yet. Check the first deliveries below and in the network's event manager before relying on it."), {
                network: t(spec.label),
                notVerified: <strong>{t("not verified with the live network")}</strong>,
              })}
            </p>
          )}
          {spec.credentials.some((c) => c.required) && !canEncrypt && (
            <p className="rounded-lg bg-alert-soft px-3 py-2 text-sm text-alert">
              {t("Credentials can't be saved on this server yet: INTEGRATIONS_ENCRYPTION_KEY isn't configured. Until it is, use a custom URL postback.")}
            </p>
          )}
          <ActionForm action={createPostbackAction.bind(null, org, app)} submitLabel={t("Save postback")} className="space-y-4">
            <input type="hidden" name="environmentId" value={env.id} />
            <input type="hidden" name="network" value={network} />
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block"><span className="label">{t("Name")}</span><input name="name" className="input" required maxLength={120} defaultValue={network === "custom" ? "" : spec.label} /></label>
              <label className="block"><span className="label">{t("Events")}</span><input name="events" className="input" required defaultValue="install" placeholder="install, re_engagement, purchase_completed" />
                <span className="help">{t("install, reinstall, re_engagement, and conversion event names from your tracking plan.")}</span></label>
              <label className="block"><span className="label">{t("Only these sources (optional)")}</span><input name="sources" className="input" placeholder={network === "custom" ? "tiktok, snapchat" : ""} />
                <span className="help">{network === "custom" ? t("Empty: every attributed install.") : t("Empty: installs attributed to {network} (by source or click id).", { network: spec.label.split(" ")[0] })}</span></label>
              {network === "custom" && (
                <label className="flex items-center gap-2 pt-6"><input type="checkbox" name="includeOrganic" /> <span className="text-sm">{t("Also send organic installs and conversions")}</span></label>
              )}
            </div>
            {network === "custom" && (
              <div className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
                  <label className="block"><span className="label">{t("URL template")}</span>
                    <input name="urlTemplate" className="input font-mono text-sm" dir="ltr" required placeholder="https://example.com/postback?click={click_id}&event={event}&value={revenue}&cur={currency}&ts={timestamp}" /></label>
                  <label className="block"><span className="label">{t("Method")}</span>
                    <select name="httpMethod" className="input"><option>GET</option><option>POST</option></select></label>
                </div>
                <p className="text-xs text-ink-3">{rich(t("Macros: {macros}. Values are URL-encoded. POST also sends them as a JSON body."), { macros: <span dir="ltr">{POSTBACK_MACROS.map((m) => `{${m}}`).join(" ")}</span> })}</p>
              </div>
            )}
            {spec.config.length > 0 && (
              <div className="grid gap-3 sm:grid-cols-2">
                {spec.config.map((f) => (
                  <label key={f.key} className="block"><span className="label">{t(f.label)}</span>
                    {f.options ? (
                      <select name={`config.${f.key}`} className="input" defaultValue={f.options[0].value}>
                        {f.options.map((o) => <option key={o.value} value={o.value}>{t(o.label)}</option>)}
                      </select>
                    ) : (
                      <input name={`config.${f.key}`} className="input" required={f.required} maxLength={500} />
                    )}
                    {f.help && <span className="help">{t(f.help)}</span>}
                  </label>
                ))}
              </div>
            )}
            {spec.credentials.length > 0 && (
              <div className="grid gap-3 sm:grid-cols-2">
                {spec.credentials.map((f) => (
                  <label key={f.key} className="block"><span className="label">{t(f.label)}</span><input name={`secret.${f.key}`} type="password" autoComplete="off" className="input" required={f.required} maxLength={4000} /></label>
                ))}
                <p className="help sm:col-span-2">{t("Encrypted at rest and never shown again. To change it, create a new postback and delete this one.")}</p>
              </div>
            )}
          </ActionForm>
        </section>
      )}

      <section className="card overflow-x-auto p-0">
        <h2 className="h2 px-5 pt-5">{t("Recent deliveries")}</h2>
        {deliveries.length === 0 ? (
          <p className="px-5 pb-5 pt-2 text-sm text-ink-3">{t("Nothing sent yet.")}</p>
        ) : (
          <table className="table mt-3">
            <thead><tr><th>{t("Queued")}</th><th>{t("Postback")}</th><th>{t("Event")}</th><th>{t("Status")}</th><th className="text-end">{t("Attempts")}</th><th>{t("Last response")}</th><th>{t("Next try")}</th></tr></thead>
            <tbody>
              {deliveries.map((d) => (
                <tr key={d.id}>
                  <td className="text-ink-3">{fmt(d.created_at, lang)}</td>
                  <td>{d.postback_name}</td>
                  <td className="font-mono text-xs">{d.event_name}</td>
                  <td>{d.status === "succeeded" ? statusName(t, d.status) : <span className={d.status === "pending" ? "" : "text-alert"}>{statusName(t, d.status)}</span>}</td>
                  <td className="text-end tabular-nums">{d.attempts}</td>
                  <td className="text-xs break-all text-ink-2">
                    {d.skip_reason ? <span className="text-warn">{t(SKIP_REASONS[d.skip_reason] ?? d.skip_reason)} </span> : null}
                    {d.last_status_code ?? ""} {d.last_error && d.last_error !== d.skip_reason ? t(d.last_error) : ""}
                    {d.provider_error_code && <span className="block text-ink-3">{t("Provider code")}: {d.provider_error_code}{d.provider_trace_id ? ` · ${t("trace")} ${d.provider_trace_id}` : ""}</span>}
                  </td>
                  <td className="text-ink-3">{d.status === "pending" ? fmt(d.next_attempt_at, lang) : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
