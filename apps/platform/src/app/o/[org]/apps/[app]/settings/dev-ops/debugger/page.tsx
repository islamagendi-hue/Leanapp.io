import { retryFailedEventsAction } from "@/app/actions/debugger";
import { ActionForm } from "@/components/ActionForm";
import { EventDebugger } from "@/components/EventDebugger";
import { listKeys } from "@/modules/credentials/service";
import { failedEvents, FAILED_WINDOW_DAYS, RETRY_BATCH_MAX } from "@/modules/debugger/service";
import { testEventCurl } from "@/modules/implementation/codegen";
import { can } from "@/modules/rbac/authorize";
import { publicBaseUrl } from "@/server/env";
import { getLang, getT } from "@/i18n/server";
import { dateLocale } from "@/i18n/translate";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export async function generateMetadata() {
  return { title: (await getT())("Event debugger") };
}

export default async function DebuggerPage(props: PageProps<"/o/[org]/apps/[app]/settings/dev-ops/debugger">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  requirePermission(ctx, "events.read");
  const env = await pickEnvironment(environments, sp.env);
  const t = await getT();
  const lang = await getLang();
  let pk = "<your public SDK key>";
  if (can(ctx.role, "credentials.read")) {
    const keys = await listKeys(ctx, a.id);
    const active = keys.sdkKeys.find((k) => k.environment_id === env.id && k.status === "active" && (!k.expires_at || new Date(k.expires_at) > new Date()));
    if (active) pk = active.key;
  }
  const failed = await failedEvents(ctx, env.id);
  const canRetry = can(ctx.role, "implementation.edit");
  const when = (d: string) => new Date(d).toLocaleString(dateLocale(lang));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="h1">{t("Event debugger")}</h1>
          <p className="mt-1 text-ink-2">{t("Every event this environment receives, as it arrives, checked against your published tracking plan.")}</p>
        </div>
      </div>
      {/* key forces a fresh feed when the environment changes */}
      <EventDebugger key={env.id} feedUrl={`/v1/organizations/${org}/environments/${env.id}/events`} testCurl={testEventCurl(publicBaseUrl(), pk)} />

      <section id="failed-events" className="space-y-3" data-testid="failed-events">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="h2">
              {t("Failed events ({days} days)", { days: FAILED_WINDOW_DAYS })}{" "}
              <span className={`font-mono ${failed.total ? "text-alert" : "text-ink-3"}`} data-testid="failed-count">{failed.total}</span>
            </h2>
            <p className="mt-1 text-sm text-ink-2">{t("An event whose processing failed stays out of every report until it is processed again successfully.")}</p>
          </div>
          {canRetry && failed.total > 0 && (
            <ActionForm
              action={retryFailedEventsAction.bind(null, org, app, env.id, null)}
              submitLabel={t("Retry failed events")}
              buttonClass="btn-secondary"
              className="flex flex-col items-end gap-2"
              confirm={t("Put up to {n} failed events back in the processing queue?", { n: RETRY_BATCH_MAX })}
            />
          )}
        </div>
        {failed.total === 0 ? (
          <p className="text-sm text-ink-3">{t("No failed events.")}</p>
        ) : (
          <div className="card overflow-x-auto p-0">
            <table className="table">
              <thead>
                <tr><th>{t("Received")}</th><th>{t("Event")}</th><th>{t("Error")}</th><th>{t("Attempts")}</th>{canRetry && <th />}</tr>
              </thead>
              <tbody>
                {failed.events.map((e) => (
                  <tr key={e.id}>
                    <td className="whitespace-nowrap font-mono text-xs text-ink-3">{when(e.received_at)}</td>
                    <td>
                      <span className="font-mono text-sm">{e.event_name}</span>
                      {e.type !== "track" && <span className="pill ms-2 border-line text-ink-3">{e.type}</span>}
                    </td>
                    <td className="max-w-md break-words font-mono text-xs text-alert" dir="ltr">{e.error}</td>
                    <td className="font-mono text-xs">{e.attempts}</td>
                    {canRetry && (
                      <td>
                        <ActionForm action={retryFailedEventsAction.bind(null, org, app, env.id, e.id)} submitLabel={t("Retry")} buttonClass="btn-secondary" className="flex flex-col gap-1" />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {failed.total > failed.events.length && (
              <p className="px-4 py-2 text-xs text-ink-3">{t("Showing the newest {shown} of {total}.", { shown: failed.events.length, total: failed.total })}</p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
