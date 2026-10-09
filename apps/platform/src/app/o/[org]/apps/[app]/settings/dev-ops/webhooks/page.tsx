import Link from "next/link";
import { createWebhookAction } from "@/app/actions/engage";
import { ActionForm } from "@/components/ActionForm";
import { StatusPill } from "@/components/engage/shared";
import { encryptionAvailable } from "@/lib/secret-box";
import { listWebhooks, WEBHOOK_EVENT_TYPES } from "@/modules/webhooks/service";
import { getT } from "@/i18n/server";
import { msg } from "@/i18n/translate";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export async function generateMetadata() {
  return { title: (await getT())("Webhooks") };
}

const EVENT_HELP: Record<string, string> = {
  "audience.entered": msg("Someone entered an active audience"),
  "audience.exited": msg("Someone left an active audience"),
  "automation.webhook": msg("An automation's webhook step ran for someone"),
};

export default async function WebhooksPage(props: PageProps<"/o/[org]/apps/[app]/settings/dev-ops/webhooks">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, environments } = await loadApp(org, app);
  requirePermission(ctx, "webhooks.manage");
  const env = await pickEnvironment(environments, sp.env);
  const hooks = await listWebhooks(ctx, env.id);
  const base = `/o/${org}/apps/${app}/settings/dev-ops/webhooks`;
  const t = await getT();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="h1">{t("Webhooks")}</h1>
          <p className="mt-1 max-w-2xl text-ink-2">{t("Signed HTTP callbacks to your servers. Failed deliveries are retried with exponential backoff (1 min doubling to 6 h) and given up after 10 attempts.")}</p>
        </div>
      </div>

      <section className="card">
        {hooks.length === 0 ? <p className="text-sm text-ink-3">{t("No webhooks in the {env} environment.", { env: t(env.type) })}</p> : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>{t("Endpoint")}</th><th>{t("Events")}</th><th>{t("Status")}</th><th className="text-end">{t("Pending")}</th><th className="text-end">{t("OK 24 h")}</th><th className="text-end">{t("Failed 24 h")}</th></tr></thead>
              <tbody>
                {hooks.map((w) => (
                  <tr key={w.id}>
                    <td><Link className="font-mono text-xs break-all hover:underline" href={`${base}/${w.id}`}>{w.url}</Link>{w.description && <div className="text-xs text-ink-3">{w.description}</div>}</td>
                    <td className="text-xs">{w.event_types.join(", ")}</td>
                    <td><StatusPill status={w.status} /></td>
                    <td className="text-end tabular-nums">{w.stats?.pending}</td>
                    <td className="text-end tabular-nums">{w.stats?.succeeded_24h}</td>
                    <td className="text-end tabular-nums">{w.stats?.failed_24h}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card space-y-3">
        <h2 className="h2">{t("Add an endpoint")}</h2>
        {!encryptionAvailable() ? (
          <p className="text-sm text-alert">{t("Webhooks can't be created on this server: {key} is not configured (signing secrets are stored encrypted).", { key: "INTEGRATIONS_ENCRYPTION_KEY" })}</p>
        ) : (
          <ActionForm action={createWebhookAction.bind(null, org, app, env.id)} submitLabel={t("Create webhook")} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block"><span className="label">{t("URL")}</span><input name="url" type="url" className="input font-mono" placeholder="https://api.example.com/hooks/leanapp" required /></label>
              <label className="block"><span className="label">{t("Description")}</span><input name="description" className="input" maxLength={200} /></label>
            </div>
            <fieldset className="space-y-1">
              <legend className="label">{t("Events")}</legend>
              {WEBHOOK_EVENT_TYPES.map((e) => (
                <label key={e} className="flex items-center gap-2 text-sm"><input type="checkbox" name="eventTypes" value={e} defaultChecked /> <code>{e}</code> <span className="text-ink-3">{EVENT_HELP[e] && t(EVENT_HELP[e])}</span></label>
              ))}
            </fieldset>
          </ActionForm>
        )}
      </section>

      <section className="card space-y-2 text-sm">
        <h2 className="h2">{t("Verifying signatures")}</h2>
        <p className="text-ink-2">{(([x, y, z, w]) => <>{x}<code dir="ltr">LeanApp-Signature: t=&lt;unix seconds&gt;,v1=&lt;hex&gt;</code>{y}<code dir="ltr">&lt;t&gt;.&lt;raw body&gt;</code>{z}<code>Idempotency-Key</code>{w}</>)(t("Each request carries {header}, where v1 is HMAC-SHA256 of {payload} with your signing secret. Reject requests older than 5 minutes, and de-duplicate on the {idempotency} header: a delivery can arrive more than once.").split(/\{header\}|\{payload\}|\{idempotency\}/))}</p>
        <pre className="code">{`const [t, v1] = header.split(",").map((p) => p.split("=")[1]);
const expected = crypto.createHmac("sha256", secret).update(\`\${t}.\${rawBody}\`).digest("hex");
const ok = Math.abs(Date.now() / 1000 - Number(t)) < 300 &&
  crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected));`}</pre>
      </section>
    </div>
  );
}
