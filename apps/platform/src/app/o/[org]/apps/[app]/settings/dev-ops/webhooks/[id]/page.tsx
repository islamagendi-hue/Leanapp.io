import Link from "next/link";
import { notFound } from "next/navigation";
import { retryDeliveryAction, webhookAction } from "@/app/actions/engage";
import { ActionForm } from "@/components/ActionForm";
import { fmtDate, StatusPill } from "@/components/engage/shared";
import { NotFoundError } from "@/lib/errors";
import { getWebhook } from "@/modules/webhooks/service";
import { getLang, getT } from "@/i18n/server";
import { loadApp, requirePermission } from "@/server/session";

export async function generateMetadata() {
  return { title: (await getT())("Webhook") };
}

const STATUSES = ["pending", "succeeded", "failed", "giving_up"];

export default async function WebhookPage(props: PageProps<"/o/[org]/apps/[app]/settings/dev-ops/webhooks/[id]">) {
  const { org, app, id } = await props.params;
  const sp = await props.searchParams;
  const { ctx, environments } = await loadApp(org, app);
  requirePermission(ctx, "webhooks.manage");
  const status = typeof sp.status === "string" && STATUSES.includes(sp.status) ? sp.status : undefined;
  const { webhook: w, deliveries } = await getWebhook(ctx, id, { status }).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  const env = environments.find((e) => e.id === w.environment_id);
  if (!env) notFound();
  const t = await getT();
  const lang = await getLang();
  const act = (op: "test" | "rotate" | "enable" | "disable" | "delete") => webhookAction.bind(null, org, app, w.id, op);

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-ink-3"><Link className="hover:underline" href={`/o/${org}/apps/${app}/settings/dev-ops/webhooks?env=${env.type}`}>{t("Webhooks")}</Link> / {t(env.type)}</p>
        <h1 className="h1 break-all font-mono text-xl sm:text-2xl">{w.url}</h1>
        <p className="mt-1 text-sm text-ink-2"><StatusPill status={w.status} /> {w.event_types.join(", ")} · {t("secret {prefix}…", { prefix: w.secret_prefix ?? "" })} {w.description && `· ${w.description}`}</p>
      </div>
      <div className="flex flex-wrap gap-3">
        <ActionForm action={act("test")} submitLabel={t("Send test event")} className="space-y-2" />
        <ActionForm action={act("rotate")} submitLabel={t("Rotate secret")} buttonClass="btn-secondary" className="space-y-2" confirm={t("Issue a new signing secret? The current one stops working immediately.")} />
        <ActionForm action={act(w.status === "active" ? "disable" : "enable")} submitLabel={w.status === "active" ? t("Disable") : t("Enable")} buttonClass="btn-secondary" className="space-y-2" />
        <ActionForm action={act("delete")} submitLabel={t("Delete")} buttonClass="btn-danger" className="space-y-2" confirm={t("Delete this webhook and its delivery log?")} />
      </div>

      <section className="card space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="h2">{t("Deliveries")}</h2>
          <nav className="flex flex-wrap gap-2 text-xs">
            {[undefined, ...STATUSES].map((s) => (
              <Link key={s ?? "all"} href={s ? `?status=${s}` : "?"} className={`pill ${status === s ? "border-ink bg-ink text-paper" : "border-line"}`}>{s ? t(s.replace("_", " ")) : t("all")}</Link>
            ))}
          </nav>
        </div>
        {deliveries.length === 0 ? <p className="text-sm text-ink-3">{t("No deliveries yet. Send a test event to try your endpoint.")}</p> : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>{t("Created")}</th><th>{t("Event")}</th><th>{t("Status")}</th><th className="text-end">{t("Attempts")}</th><th>{t("Last attempt")}</th><th>{t("Detail")}</th><th /></tr></thead>
              <tbody>
                {deliveries.map((d) => (
                  <tr key={d.id}>
                    <td className="text-ink-3">{fmtDate(d.created_at, lang)}</td>
                    <td className="font-mono text-xs">{d.event_type}</td>
                    <td><StatusPill status={d.status} /></td>
                    <td className="text-end tabular-nums">{d.attempts}</td>
                    <td className="text-xs text-ink-3">
                      {fmtDate(d.last_attempt_at, lang)}
                      {d.last_status_code !== null && <> · HTTP {d.last_status_code}</>}
                      {d.last_duration_ms !== null && <> · {d.last_duration_ms} ms</>}
                      {d.status === "pending" && d.next_attempt_at && <div>{t("next {date}", { date: fmtDate(d.next_attempt_at, lang) })}</div>}
                    </td>
                    <td className="max-w-xs text-xs">
                      {d.last_error && <div className="text-alert">{d.last_error}</div>}
                      <details><summary className="cursor-pointer text-ink-2">{t("payload")}</summary><pre className="code mt-1 max-h-60 text-[11px]">{JSON.stringify(d.payload, null, 2)}</pre>
                        {d.last_response && <><p className="mt-1 text-ink-3">{t("response")}</p><pre className="code max-h-40 text-[11px]">{d.last_response}</pre></>}
                      </details>
                    </td>
                    <td>{(d.status === "failed" || d.status === "giving_up") && <ActionForm action={retryDeliveryAction.bind(null, org, app, w.id, d.id)} submitLabel={t("Retry")} buttonClass="btn-secondary min-h-8 text-xs" className="space-y-1" />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
