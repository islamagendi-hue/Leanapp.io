import Link from "next/link";
import { createWebhookAction } from "@/app/actions/engage";
import { ActionForm } from "@/components/ActionForm";
import { EnvSwitcher } from "@/components/EnvSwitcher";
import { StatusPill } from "@/components/engage/shared";
import { secretsAvailable } from "@/lib/secret-box";
import { listWebhooks, WEBHOOK_EVENT_TYPES } from "@/modules/webhooks/service";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export const metadata = { title: "Webhooks" };

const EVENT_HELP: Record<string, string> = {
  "audience.entered": "Someone entered an active audience",
  "audience.exited": "Someone left an active audience",
  "automation.webhook": "An automation's webhook step ran for someone",
};

export default async function WebhooksPage(props: PageProps<"/o/[org]/apps/[app]/developers/webhooks">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, environments } = await loadApp(org, app);
  requirePermission(ctx, "webhooks.manage");
  const env = pickEnvironment(environments, sp.env);
  const hooks = await listWebhooks(ctx, env.id);
  const base = `/o/${org}/apps/${app}/developers/webhooks`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="h1">Webhooks</h1>
          <p className="mt-1 max-w-2xl text-ink-2">Signed HTTP callbacks to your servers. Failed deliveries are retried with exponential backoff (1 min doubling to 6 h) and given up after 10 attempts.</p>
        </div>
        <EnvSwitcher path={base} current={env.type} />
      </div>

      <section className="card">
        {hooks.length === 0 ? <p className="text-sm text-ink-3">No webhooks in the {env.type} environment.</p> : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>Endpoint</th><th>Events</th><th>Status</th><th className="text-end">Pending</th><th className="text-end">OK 24 h</th><th className="text-end">Failed 24 h</th></tr></thead>
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
        <h2 className="h2">Add an endpoint</h2>
        {!secretsAvailable() ? (
          <p className="text-sm text-alert">Webhooks can&apos;t be created on this server: <code>INTEGRATIONS_ENCRYPTION_KEY</code> is not configured (signing secrets are stored encrypted).</p>
        ) : (
          <ActionForm action={createWebhookAction.bind(null, org, app, env.id)} submitLabel="Create webhook" className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block"><span className="label">URL</span><input name="url" type="url" className="input font-mono" placeholder="https://api.example.com/hooks/leanapp" required /></label>
              <label className="block"><span className="label">Description</span><input name="description" className="input" maxLength={200} /></label>
            </div>
            <fieldset className="space-y-1">
              <legend className="label">Events</legend>
              {WEBHOOK_EVENT_TYPES.map((e) => (
                <label key={e} className="flex items-center gap-2 text-sm"><input type="checkbox" name="eventTypes" value={e} defaultChecked /> <code>{e}</code> <span className="text-ink-3">{EVENT_HELP[e]}</span></label>
              ))}
            </fieldset>
          </ActionForm>
        )}
      </section>

      <section className="card space-y-2 text-sm">
        <h2 className="h2">Verifying signatures</h2>
        <p className="text-ink-2">Each request carries <code>LeanApp-Signature: t=&lt;unix seconds&gt;,v1=&lt;hex&gt;</code>, where v1 is HMAC-SHA256 of <code>&lt;t&gt;.&lt;raw body&gt;</code> with your signing secret. Reject requests older than 5 minutes, and de-duplicate on the <code>Idempotency-Key</code> header: a delivery can arrive more than once.</p>
        <pre className="code">{`const [t, v1] = header.split(",").map((p) => p.split("=")[1]);
const expected = crypto.createHmac("sha256", secret).update(\`\${t}.\${rawBody}\`).digest("hex");
const ok = Math.abs(Date.now() / 1000 - Number(t)) < 300 &&
  crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected));`}</pre>
      </section>
    </div>
  );
}
