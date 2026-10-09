import Link from "next/link";
import { notFound } from "next/navigation";
import {
  removeConnectionAction, requestBackfillAction, saveAdConnectionAction, setCapabilityAction, startOAuthAction, syncNowAction, verifyConnectionAction,
} from "@/app/actions/integrations";
import { envName } from "@/components/acquisition/rich";
import { ActionForm } from "@/components/ActionForm";
import { CapabilityStatusPill } from "@/components/integrations/CapabilityStatus";
import { getLang, getT } from "@/i18n/server";
import { dateLocale, type Lang } from "@/i18n/translate";
import { encryptionAvailable } from "@/lib/secret-box";
import { localDate } from "@/modules/analytics/range";
import { AD_ADAPTERS } from "@/modules/integrations/ads";
import { oauthConfigured } from "@/modules/integrations/oauth";
import { CONVERSION_NETWORK, isAdProvider, providerById } from "@/modules/integrations/registry";
import { campaignSummary, listConnections, listSyncRuns } from "@/modules/integrations/service";
import { addDays, freshness, MAX_BACKFILL_DAYS } from "@/modules/integrations/status";
import { can } from "@/modules/rbac/authorize";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export async function generateMetadata(props: PageProps<"/o/[org]/apps/[app]/settings/integrations/[provider]">) {
  const { provider } = await props.params;
  return { title: providerById(provider)?.name ?? (await getT())("Integrations") };
}

const when = (d: Date | null, lang: Lang) => (d ? new Date(d).toLocaleString(dateLocale(lang)) : "–");

export default async function ProviderPage(props: PageProps<"/o/[org]/apps/[app]/settings/integrations/[provider]">) {
  const { org, app, provider } = await props.params;
  if (!isAdProvider(provider)) notFound();
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  requirePermission(ctx, "integrations.read");
  const env = await pickEnvironment(environments, sp.env);
  const [t, lang] = await Promise.all([getT(), getLang()]);
  const descriptor = providerById(provider)!;
  const adapter = AD_ADAPTERS[provider];
  const conn = (await listConnections(ctx, a.id, env.id)).find((c) => c.provider === provider) ?? null;
  const [runs, campaigns] = conn ? await Promise.all([listSyncRuns(ctx, a.id, conn.id, 15), campaignSummary(ctx, a.id, conn.id)]) : [[], []];
  const manage = can(ctx.role, "integrations.manage");
  const reporting = conn?.capabilities.find((c) => c.capability === "ad_reporting");
  const spend = conn?.capabilities.find((c) => c.capability === "spend_import");
  const today = localDate(new Date(), a.timezone);
  const oauth = typeof sp.oauth === "string" ? sp.oauth : null;
  const canEncrypt = encryptionAvailable();
  const conversionsCap = descriptor.capabilities.find((c) => c.id === "conversions_outbound")!;

  return (
    <div className="space-y-6">
      <div>
        <Link href={`/o/${org}/apps/${app}/settings/integrations`} className="text-sm text-ink-2 underline">{t("Integrations")}</Link>
        <h1 className="h1 mt-1">{descriptor.name}</h1>
        <p className="mt-1 max-w-3xl text-ink-2">
          {t("Ad reporting and cost import for {env}. Built from the provider's published API and not yet verified with a live account: the status below turns Verified only after a real call succeeds.", { env: envName(t, env.type) })}
        </p>
      </div>

      {oauth === "connected" && <p className="rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent-ink">{t("Connected. Use Test connection to check access, then choose the ad accounts.")}</p>}
      {oauth === "denied" && <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">{t("The connection was cancelled at the provider.")}</p>}
      {oauth === "error" && <p className="rounded-lg bg-alert-soft px-3 py-2 text-sm text-alert">{t("The provider didn't complete the connection. Try again, or enter credentials below.")}</p>}
      {!canEncrypt && <p className="rounded-lg bg-alert-soft px-3 py-2 text-sm text-alert">{t("Credentials can't be stored on this server: {key} is not configured. Nothing below can be connected until the operator sets it.", { key: "INTEGRATIONS_ENCRYPTION_KEY" })}</p>}

      <section className="grid gap-3 md:grid-cols-3">
        {[
          { title: t("Ad reporting import"), cap: reporting },
          { title: t("Cost import into Ad spend"), cap: spend },
        ].map(({ title, cap }) => {
          const fresh = cap?.data_fresh_through ? freshness(cap.data_fresh_through, today) : null;
          return (
            <div key={title} className="card space-y-1 text-sm">
              <div className="flex items-center justify-between gap-2"><span className="font-medium">{title}</span><CapabilityStatusPill t={t} status={cap?.status ?? "not_configured"} /></div>
              {cap?.status === "credentials_missing" && cap.status_detail && <p className="text-xs text-warn">{t("Missing: {fields}", { fields: cap.status_detail })}</p>}
              <p className="text-xs text-ink-2">{t("Last success")}: {when(cap?.last_success_at ?? null, lang)}</p>
              <p className={`text-xs ${fresh?.state === "stale" ? "text-warn" : "text-ink-2"}`}>{t("Data through")}: {cap?.data_fresh_through ?? "–"}</p>
              {cap?.next_sync_at && <p className="text-xs text-ink-3">{t("Next import")}: {when(cap.next_sync_at, lang)}</p>}
              {cap?.backfill_from && <p className="text-xs text-ink-3">{t("History import down to {day} in progress", { day: cap.backfill_from })}</p>}
              {cap?.last_error && cap.status === "error" && <p className="text-xs break-words text-alert">{cap.last_error}</p>}
            </div>
          );
        })}
        <div className="card space-y-1 text-sm">
          <div className="font-medium">{t(conversionsCap.title)}</div>
          <p className="text-xs text-ink-2">{t("Sending conversions is set up separately, as a postback, and doesn't use this connection.")}</p>
          <Link href={`/o/${org}/apps/${app}/settings/dev-ops/attribution/postbacks?network=${CONVERSION_NETWORK[provider]}`} className="text-xs font-medium text-accent-ink underline">{t("Open postbacks")}</Link>
        </div>
      </section>

      {manage && (
        <section className="card space-y-4">
          <h2 className="h2">{t("Credentials and settings")}</h2>
          {conn && <p className="text-xs text-ink-3">{conn.auth_method === "oauth" ? t("Connected with OAuth through LeanApp's app.") : t("Credentials entered by hand.")} {t("Last changed")}: {when(conn.credentials_updated_at, lang)}{conn.granted_scopes.length ? ` · ${t("Permissions granted")}: ${conn.granted_scopes.join(", ")}` : ""}</p>}
          {oauthConfigured(provider) ? (
            <ActionForm action={startOAuthAction.bind(null, org, app, provider)} submitLabel={t("Connect with {provider}", { provider: descriptor.name })} buttonClass="btn-secondary" className="">
              <input type="hidden" name="env" value={env.type} />
            </ActionForm>
          ) : (
            <p className="text-sm text-ink-3">{t("Connecting with OAuth needs LeanApp's own {provider} app, which this server doesn't have yet. Enter your own credentials instead.", { provider: descriptor.name })}</p>
          )}
          <ActionForm action={saveAdConnectionAction.bind(null, org, app, provider)} submitLabel={t("Save")} className="space-y-4">
            <input type="hidden" name="env" value={env.type} />
            <div className="grid gap-3 sm:grid-cols-2">
              {adapter.settings.map((f) => (
                <label key={f.key} className="block"><span className="label">{t(f.label)}{f.required ? " *" : ""}</span>
                  <input name={`settings.${f.key}`} className="input font-mono text-sm" dir="ltr" maxLength={500} defaultValue={conn?.config[f.key] ?? ""} /></label>
              ))}
              {adapter.secrets.map((f) => (
                <label key={f.key} className="block"><span className="label">{t(f.label)}{f.required ? " *" : ""}</span>
                  <input name={`secret.${f.key}`} type="password" autoComplete="off" className="input" maxLength={4000} placeholder={conn?.has_credentials ? t("Stored. Leave blank to keep.") : ""} /></label>
              ))}
            </div>
            <p className="help">{t("Secrets are encrypted at rest and never shown again. Saving credentials doesn't start imports: turn them on below.")}</p>
          </ActionForm>
          {conn && (
            <div className="flex flex-wrap gap-2">
              <ActionForm action={verifyConnectionAction.bind(null, org, app, provider, conn.id)} submitLabel={t("Test connection")} buttonClass="btn-secondary" className="" />
              {reporting?.enabled && <ActionForm action={syncNowAction.bind(null, org, app, provider, conn.id)} submitLabel={t("Import now")} pendingLabel={t("Importing…")} buttonClass="btn-secondary" className="" />}
              <ActionForm action={removeConnectionAction.bind(null, org, app, provider, conn.id)} submitLabel={t("Remove connection")} buttonClass="btn-danger" className="" confirm={t("Remove this connection, its imported reporting and its imported Ad spend? Spend you entered by hand stays.")} />
            </div>
          )}
        </section>
      )}

      {manage && conn && (
        <section className="card space-y-4">
          <h2 className="h2">{t("Capabilities")}</h2>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="font-medium">{t("Ad reporting import")}</span>
            <ActionForm action={setCapabilityAction.bind(null, org, app, provider, conn.id, "ad_reporting", !reporting?.enabled)} submitLabel={reporting?.enabled ? t("Turn off") : t("Turn on")} buttonClass="btn-secondary min-h-8 px-3" className="" />
          </div>
          <ActionForm action={setCapabilityAction.bind(null, org, app, provider, conn.id, "spend_import", !spend?.enabled)} submitLabel={spend?.enabled ? t("Turn off cost import") : t("Turn on cost import")} buttonClass="btn-secondary min-h-8 px-3" className="flex flex-wrap items-end gap-3">
            {!spend?.enabled && (
              <label className="block"><span className="label">{t("Source name in Ad spend")}</span>
                <input name="spendSource" className="input font-mono text-sm" dir="ltr" maxLength={100} defaultValue={spend?.config.spend_source ?? adapter.defaultSpendSource} />
                <span className="help">{t("Use the same source name your tracking links use, so cost lines up with installs.")}</span></label>
            )}
          </ActionForm>
          {reporting?.enabled && (
            <ActionForm action={requestBackfillAction.bind(null, org, app, provider, conn.id)} submitLabel={t("Import history")} buttonClass="btn-secondary min-h-8 px-3" className="flex flex-wrap items-end gap-3">
              <label className="block"><span className="label">{t("From day")}</span>
                <input type="date" name="from" className="input" min={addDays(today, -MAX_BACKFILL_DAYS)} max={addDays(today, -1)} required /></label>
            </ActionForm>
          )}
        </section>
      )}

      {conn && (
        <section className="card overflow-x-auto p-0">
          <h2 className="h2 px-5 pt-5">{t("Import runs")}</h2>
          {runs.length === 0 ? (
            <p className="px-5 pb-5 pt-2 text-sm text-ink-3">{t("Nothing imported yet.")}</p>
          ) : (
            <table className="table mt-3">
              <thead><tr><th>{t("Started")}</th><th>{t("Kind")}</th><th>{t("Days")}</th><th>{t("Status")}</th><th className="text-end">{t("Rows")}</th><th className="text-end">{t("Spend rows")}</th><th className="text-end">{t("Kept (entered by hand)")}</th><th>{t("Error")}</th></tr></thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td className="text-ink-3">{when(r.started_at, lang)}</td>
                    <td>{r.kind === "backfill" ? t("History") : r.kind === "manual" ? t("Manual") : t("Scheduled")}</td>
                    <td className="font-mono text-xs">{r.range_from} → {r.range_to}</td>
                    <td className={r.status === "failed" ? "text-alert" : ""}>{r.status === "succeeded" ? t("Succeeded") : r.status === "failed" ? t("Failed") : t("Running")}</td>
                    <td className="text-end tabular-nums">{r.rows_imported}</td>
                    <td className="text-end tabular-nums">{r.spend_rows}</td>
                    <td className="text-end tabular-nums">{r.spend_skipped}</td>
                    <td className="max-w-md text-xs break-words text-alert">{r.error ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {campaigns.length > 0 && (
        <section className="card overflow-x-auto p-0">
          <h2 className="h2 px-5 pt-5">{t("Imported campaigns, last 30 days")}</h2>
          <table className="table mt-3">
            <thead><tr><th>{t("Campaign")}</th><th className="text-end">{t("Impressions")}</th><th className="text-end">{t("Clicks")}</th><th className="text-end">{t("Spend")}</th><th className="text-end">{t("Conversions")}</th></tr></thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={`${c.campaign_id}-${c.currency}`}>
                  <td>{c.campaign_name ?? c.campaign_id}<div className="font-mono text-xs text-ink-3" dir="ltr">{c.campaign_id}</div></td>
                  <td className="text-end tabular-nums">{c.impressions.toLocaleString(dateLocale(lang))}</td>
                  <td className="text-end tabular-nums">{c.clicks.toLocaleString(dateLocale(lang))}</td>
                  <td className="text-end tabular-nums">{c.spend.toLocaleString(dateLocale(lang), { maximumFractionDigits: 2 })} {c.currency}</td>
                  <td className="text-end tabular-nums">{c.conversions === null ? "–" : c.conversions.toLocaleString(dateLocale(lang))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
