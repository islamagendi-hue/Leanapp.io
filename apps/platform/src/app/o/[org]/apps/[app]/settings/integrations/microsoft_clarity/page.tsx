import Link from "next/link";
import { clarityImportNowAction, removeClarityAction, saveClarityAction, setClarityImportAction } from "@/app/actions/clarity";
import { envName } from "@/components/acquisition/rich";
import { ActionForm } from "@/components/ActionForm";
import { CapabilityStatusPill } from "@/components/integrations/CapabilityStatus";
import { getLang, getT } from "@/i18n/server";
import { dateLocale, msg, type Lang } from "@/i18n/translate";
import { encryptionAvailable } from "@/lib/secret-box";
import { capabilityState } from "@/modules/integrations/center";
import {
  CLARITY_ANONYMOUS_TAG, CLARITY_DAILY_LIMIT, CLARITY_DIMENSIONS, CLARITY_IMPORT_CAPABILITY, clarityProjectUrl, isClarityDimension, METRICS, metricKey,
  REQUESTS_PER_IMPORT, shownField, specFor,
} from "@/modules/integrations/clarity";
import { clarityView } from "@/modules/integrations/clarity-service";
import { providerById } from "@/modules/integrations/registry";
import { listSyncRuns } from "@/modules/integrations/service";
import { freshness } from "@/modules/integrations/status";
import { can } from "@/modules/rbac/authorize";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export async function generateMetadata() {
  return { title: "Microsoft Clarity" };
}

const when = (d: Date | null, lang: Lang) => (d ? new Date(d).toLocaleString(dateLocale(lang)) : "–");
const fmt = (n: number | undefined, lang: Lang) => (n === undefined ? "–" : n.toLocaleString(dateLocale(lang), { maximumFractionDigits: 2 }));

const DIMENSION_LABEL: Record<string, string> = { URL: msg("Page URL"), Device: msg("Device"), Source: msg("Source") };

function Code({ children }: { children: string }) {
  return <pre className="overflow-x-auto rounded-lg bg-paper-2 p-3 font-mono text-xs leading-relaxed" dir="ltr">{children}</pre>;
}

export default async function ClarityPage(props: PageProps<"/o/[org]/apps/[app]/settings/integrations/microsoft_clarity">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  requirePermission(ctx, "integrations.read");
  const env = await pickEnvironment(environments, sp.env);
  const dimension = isClarityDimension(sp.dim) ? sp.dim : "URL";
  const [t, lang] = await Promise.all([getT(), getLang()]);
  const view = await clarityView(ctx, a.id, env.id, dimension);
  const conn = view.connection;
  const cap = conn?.capabilities.find((c) => c.capability === CLARITY_IMPORT_CAPABILITY) ?? null;
  const runs = conn ? await listSyncRuns(ctx, a.id, conn.id, 10) : [];
  const manage = can(ctx.role, "integrations.manage");
  const descriptor = providerById("microsoft_clarity")!;
  const today = new Date().toISOString().slice(0, 10);
  const fresh = cap?.data_fresh_through ? freshness(cap.data_fresh_through, today, 1) : null;
  const projectId = conn?.config.project_id ?? "";
  const projectUrl = projectId ? clarityProjectUrl(projectId) : null;
  const centerInput = { connections: conn ? [conn] : [], postbacks: null, messaging: null, webhooks: null, skan: null, links: null, deepLinks: null, sdk: null, paymentsConnected: null };
  const base = `/o/${org}/apps/${app}/settings/integrations/microsoft_clarity`;
  const dimHref = (d: string) => `${base}?${new URLSearchParams({ env: env.type, dim: d })}`;
  // Columns: the known metrics present in this snapshot, then any others Clarity sent.
  const known = METRICS.filter((m) => view.metrics.some((x) => metricKey(x) === m.key));
  const others = view.metrics.filter((x) => !specFor(x)).sort();
  const columns = [
    ...known.map((m) => ({ name: view.metrics.find((x) => metricKey(x) === m.key)!, label: t(m.label) })),
    ...others.map((x) => ({ name: x, label: x })),
  ];
  const used = view.usedToday;
  const canImport = used + REQUESTS_PER_IMPORT <= CLARITY_DAILY_LIMIT;

  return (
    <div className="space-y-6">
      <div>
        <Link href={`/o/${org}/apps/${app}/settings/integrations?env=${env.type}`} className="text-sm text-ink-2 underline">{t("Integrations")}</Link>
        <h1 className="h1 mt-1">Microsoft Clarity</h1>
        <p className="mt-1 max-w-3xl text-ink-2">
          {t("Session recordings and heatmaps stay in Clarity. For {env}, LeanApp links your users to Clarity, imports Clarity's daily aggregate metrics, and opens your Clarity project from a user profile. Built from Microsoft's published documentation and not yet verified with a live Clarity project.", { env: envName(t, env.type) })}
        </p>
      </div>

      {!encryptionAvailable() && <p className="rounded-lg bg-alert-soft px-3 py-2 text-sm text-alert">{t("Credentials can't be stored on this server: {key} is not configured. Nothing below can be connected until the operator sets it.", { key: "INTEGRATIONS_ENCRYPTION_KEY" })}</p>}

      <section className="grid gap-3 md:grid-cols-3" aria-label={t("Capabilities")}>
        {descriptor.capabilities.map((c) => {
          const s = capabilityState(descriptor, c, centerInput);
          return (
            <div key={c.id} className="card space-y-1 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{t(c.title)}</span><CapabilityStatusPill t={t} status={s.status} /></div>
              <p className="text-xs text-ink-2">{t(c.description)}</p>
              {s.detail && <p className="text-xs text-ink-3">{t(s.detail)}</p>}
              {c.id === "clarity_metrics_import" && (
                <>
                  {cap?.status === "credentials_missing" && cap.status_detail && <p className="text-xs text-warn">{t("Missing: {fields}", { fields: t(cap.status_detail) })}</p>}
                  <p className="text-xs text-ink-2">{t("Last success")}: {when(cap?.last_success_at ?? null, lang)}</p>
                  {cap?.next_sync_at && <p className="text-xs text-ink-3">{t("Next import")}: {when(cap.next_sync_at, lang)}</p>}
                  {cap?.last_error && cap.status === "error" && <p className="text-xs break-words text-alert">{cap.last_error}</p>}
                </>
              )}
            </div>
          );
        })}
      </section>

      {manage && (
        <section className="card space-y-4">
          <h2 className="h2">{t("Connection")}</h2>
          {conn && <p className="text-xs text-ink-3">{t("Last changed")}: {when(conn.credentials_updated_at, lang)}</p>}
          <ActionForm action={saveClarityAction.bind(null, org, app)} submitLabel={t("Save")} className="space-y-4">
            <input type="hidden" name="env" value={env.type} />
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block"><span className="label">{t("Clarity project ID")}</span>
                <input name="projectId" className="input font-mono text-sm" dir="ltr" maxLength={20} defaultValue={projectId} autoComplete="off" />
                <span className="help">{t("Shown in Clarity under Settings → Overview, and in your Clarity tag's address (clarity.ms/tag/<project ID>). Used for the link from user profiles.")}</span></label>
              <label className="block"><span className="label">{t("Data Export API token")}</span>
                <input name="apiToken" type="password" autoComplete="off" className="input" maxLength={4000} placeholder={conn?.has_credentials ? t("Stored. Leave blank to keep.") : ""} />
                <span className="help">{t("A project admin makes it in Clarity: Settings → Data Export → Generate new API token.")}</span></label>
            </div>
            <p className="help">{t("The token is encrypted at rest and never shown again. Saving doesn't start imports: turn the daily import on below.")}</p>
          </ActionForm>
          {conn && (
            <div className="flex flex-wrap items-end gap-2">
              <ActionForm action={setClarityImportAction.bind(null, org, app, conn.id, !cap?.enabled)} submitLabel={cap?.enabled ? t("Turn off daily import") : t("Turn on daily import")} buttonClass="btn-secondary" className="" />
              {cap?.enabled && canImport && (
                <ActionForm action={clarityImportNowAction.bind(null, org, app, conn.id)} submitLabel={t("Import now")} pendingLabel={t("Importing…")} buttonClass="btn-secondary" className="flex flex-wrap items-end gap-2">
                  <label className="block"><span className="label">{t("Period")}</span>
                    <select name="days" className="input input-sm" defaultValue="1">
                      <option value="1">{t("Last 24 hours")}</option>
                      <option value="2">{t("Last 48 hours")}</option>
                      <option value="3">{t("Last 72 hours")}</option>
                    </select></label>
                </ActionForm>
              )}
              <ActionForm action={removeClarityAction.bind(null, org, app, conn.id)} submitLabel={t("Remove connection")} buttonClass="btn-danger" className="" confirm={t("Remove the Clarity connection and its imported metrics?")} />
            </div>
          )}
          {conn && (
            <p className={`text-xs ${canImport ? "text-ink-3" : "text-warn"}`}>
              {t("Requests to Clarity today (UTC): {used} of {limit}. Each import uses {n}.", { used, limit: CLARITY_DAILY_LIMIT, n: REQUESTS_PER_IMPORT })}
              {!canImport && ` ${t("No import fits in what is left today.")}`}
            </p>
          )}
        </section>
      )}

      <section className="card-table" aria-labelledby="clarity-metrics">
        <div className="card-header">
          <h2 id="clarity-metrics" className="card-title">{t("Imported Clarity metrics")} <span className="pill ms-1 border-line text-ink-3">{t("Imported")}</span></h2>
          {view.snapshot && (
            <span className={`text-xs ${fresh?.state === "stale" ? "text-warn" : "text-ink-3"}`}>
              {t("Last {hours} hours before {time} (UTC data), imported {imported}", { hours: view.snapshot.num_of_days * 24, time: when(view.snapshot.period_end, lang), imported: when(view.snapshot.imported_at, lang) })}
              {fresh?.state === "stale" ? ` · ${t("{n} days behind", { n: fresh.lagDays ?? 0 })}` : ""}
            </span>
          )}
        </div>
        <nav className="flex flex-wrap gap-2 px-5 pb-3" aria-label={t("Breakdown")}>
          {CLARITY_DIMENSIONS.map((d) => (
            <Link key={d} href={dimHref(d)} aria-current={d === dimension ? "page" : undefined}
              className={`pill ${d === dimension ? "border-accent text-accent-ink" : "border-line text-ink-2"}`}>{t(DIMENSION_LABEL[d])}</Link>
          ))}
        </nav>
        {!view.snapshot ? (
          <p className="text-sm text-ink-3">{conn ? t("Nothing imported yet.") : t("Connect Clarity above to import its metrics.")}</p>
        ) : (
          <>
            <div className="table-scroll"><table className="table">
              <thead><tr>
                <th>{t(DIMENSION_LABEL[dimension])}</th>
                {columns.map((c) => <th key={c.name} className="num">{c.label}</th>)}
              </tr></thead>
              <tbody>
                {view.rows.map((r) => (
                  <tr key={r.value}>
                    <td className="min-w-48 max-w-xs break-words" dir="ltr">{r.value || t("(not set)")}</td>
                    {columns.map((c) => {
                      const values = r.metrics[c.name];
                      const f = values ? shownField(specFor(c.name), values) : null;
                      return <td key={c.name} className="num">{f ? fmt(values![f], lang) : "–"}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table></div>
            <p className="text-xs text-ink-3">
              {t("Values as Clarity reports them, for the period above. Each column shows one Clarity field:")}
            </p>
            <ul className="flex flex-wrap gap-x-4 gap-y-1 px-5 pb-4 font-mono text-[11px] text-ink-3" dir="ltr">
              {columns.map((c) => {
                const sample = view.rows.map((r) => r.metrics[c.name]).find(Boolean);
                return <li key={c.name}>{c.name}: {sample ? shownField(specFor(c.name), sample) ?? "–" : "–"}</li>;
              })}
            </ul>
          </>
        )}
      </section>

      {view.history.length > 0 && (
        <section className="card-table" aria-labelledby="clarity-history">
          <div className="card-header"><h2 id="clarity-history" className="card-title">{t("Sessions per import")}</h2></div>
          <div className="table-scroll"><table className="table">
            <thead><tr><th>{t("Imported on (UTC)")}</th><th>{t("Period")}</th><th className="num">{t("Sessions")}</th></tr></thead>
            <tbody>
              {view.history.map((h) => (
                <tr key={h.snapshot_date}>
                  <td className="font-mono text-xs">{h.snapshot_date}</td>
                  <td>{t("Last {hours} hours", { hours: h.num_of_days * 24 })}</td>
                  <td className="num">{h.sessions === null ? "–" : fmt(h.sessions, lang)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
          <p className="text-xs text-ink-3">{t("Sessions summed over devices from Clarity's Traffic metric. Periods can overlap, so don't add rows up.")}</p>
        </section>
      )}

      <section className="card space-y-3 text-sm">
        <h2 className="h2">{t("Open Clarity from user profiles")}</h2>
        {projectUrl ? (
          <p>{t("User profiles link to your Clarity project. There, filter recordings by the custom tag {tag} with the anonymous ID shown on the profile.", { tag: CLARITY_ANONYMOUS_TAG })}{" "}
            <a href={projectUrl} target="_blank" rel="noreferrer" className="font-medium text-accent-ink underline">{t("Open Clarity project")}</a></p>
        ) : (
          <p className="text-ink-3">{t("Add your Clarity project ID above to show a Clarity link on user profiles.")}</p>
        )}
      </section>

      <section className="card space-y-3 text-sm">
        <h2 className="h2">{t("Link LeanApp users to Clarity recordings (web)")}</h2>
        <ol className="list-decimal space-y-2 ps-5">
          <li>{t("Install Clarity's tag on your website: in Clarity, Settings → Setup → Get tracking code, and paste it in the page's head. LeanApp never loads Clarity for you.")}</li>
          <li>{t("Turn the bridge on in the LeanApp web SDK:")}
            <Code>{`Analytics.initialize({\n  apiKey: "la_pk_…",\n  clarity: { enabled: true },\n});`}</Code>
          </li>
          <li>{t("With analytics consent, the SDK then calls Clarity's identify with the LeanApp user ID (or the anonymous ID) and sets the custom tag {tag}.", { tag: CLARITY_ANONYMOUS_TAG })}</li>
          <li>{t("In the EEA, the UK and Switzerland Clarity needs its own consent signal. Send it from your consent banner with Clarity's Consent API; LeanApp doesn't send it for you:")}
            <Code>{`window.clarity("consentv2", {\n  ad_Storage: "denied",\n  analytics_Storage: "granted",\n});`}</Code>
          </li>
        </ol>
        <p className="flex flex-wrap gap-3">
          <a href="https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-setup" target="_blank" rel="noreferrer" className="text-ink-2 underline">{t("Clarity setup guide")}</a>
          <a href="https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-consent-api-v2" target="_blank" rel="noreferrer" className="text-ink-2 underline">{t("Clarity Consent API")}</a>
          <a href={descriptor.docsUrl} target="_blank" rel="noreferrer" className="text-ink-2 underline">{t("Data Export API")}</a>
        </p>
      </section>

      {conn && (
        <section className="card-table" aria-labelledby="clarity-runs">
          <div className="card-header"><h2 id="clarity-runs" className="card-title">{t("Import runs")}</h2></div>
          {runs.length === 0 ? (
            <p className="text-sm text-ink-3">{t("Nothing imported yet.")}</p>
          ) : (
            <div className="table-scroll"><table className="table">
              <thead><tr><th>{t("Started")}</th><th>{t("Kind")}</th><th>{t("Status")}</th><th className="num">{t("Rows")}</th><th className="num">{t("Requests")}</th><th>{t("Error")}</th></tr></thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap text-ink-3">{when(r.started_at, lang)}</td>
                    <td>{r.kind === "manual" ? t("Manual") : t("Scheduled")}</td>
                    <td className={r.status === "failed" ? "text-alert" : ""}>{r.status === "succeeded" ? t("Succeeded") : r.status === "failed" ? t("Failed") : t("Running")}</td>
                    <td className="num">{r.rows_imported}</td>
                    <td className="num">{r.requests}</td>
                    <td className="max-w-md text-xs break-words text-alert">{r.error ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </section>
      )}
    </div>
  );
}
