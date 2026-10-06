import Link from "next/link";
import { createPostbackAction, setPostbackStatusAction } from "@/app/actions/attribution";
import { param } from "@/components/AnalyticsHeader";
import { ActionForm } from "@/components/ActionForm";
import { EnvSwitcher } from "@/components/EnvSwitcher";
import { encryptionAvailable } from "@/lib/secret-box";
import { NETWORK_SPECS, NETWORKS, type Network } from "@/modules/attribution/networks";
import { POSTBACK_MACROS } from "@/modules/attribution/pure";
import { listPostbacks } from "@/modules/attribution/service";
import { can } from "@/modules/rbac/authorize";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export const metadata = { title: "Postbacks" };

const fmt = (d: Date | null) => (d ? new Date(d).toLocaleString("en-GB") : "–");

export default async function PostbacksPage(props: PageProps<"/o/[org]/apps/[app]/attribution/postbacks">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  requirePermission(ctx, "attribution.read");
  const env = pickEnvironment(environments, sp.env ?? "production");
  const { postbacks, deliveries } = await listPostbacks(ctx, a.id, env.id);
  const manage = can(ctx.role, "attribution.manage");
  const base = `/o/${org}/apps/${app}/attribution/postbacks`;
  const requested = param(sp.network);
  const network: Network = (NETWORKS as readonly string[]).includes(requested ?? "") ? (requested as Network) : "custom";
  const spec = NETWORK_SPECS[network];
  const canEncrypt = encryptionAvailable();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="h1">Postbacks</h1>
          <p className="mt-1 max-w-2xl text-ink-2">
            Tell ad networks and your own systems about the installs and conversions they drove. Deliveries are queued as events are processed and sent by the
            scheduled worker, with retries (1 min → 12 h) on errors.
          </p>
        </div>
        <EnvSwitcher path={base} current={env.type} query={sp} />
      </div>

      <section className="card overflow-x-auto p-0">
        {postbacks.length === 0 ? (
          <p className="p-5 text-sm text-ink-3">No postbacks in {env.type}.</p>
        ) : (
          <table className="table">
            <thead><tr><th>Postback</th><th>Events</th><th>Status</th><th className="text-end">Sent</th><th className="text-end">Queued</th><th className="text-end">Failed</th><th></th></tr></thead>
            <tbody>
              {postbacks.map((p) => (
                <tr key={p.id}>
                  <td>
                    <div className="font-medium">{p.name}</div>
                    <div className="text-xs text-ink-3">
                      {NETWORK_SPECS[p.network].label}
                      {!NETWORK_SPECS[p.network].verified && <span className="pill ms-2 border-warn/40 text-warn">not verified with the live network</span>}
                    </div>
                    {p.url_template && <code className="mt-1 block font-mono text-xs break-all text-ink-2">{p.http_method} {p.url_template}</code>}
                    {p.network !== "custom" && !p.has_credentials && <div className="text-xs text-alert">Not connected: no credentials stored.</div>}
                  </td>
                  <td className="font-mono text-xs">
                    {p.events.join(", ")}
                    {p.sources.length > 0 && <div className="text-ink-3">sources: {p.sources.join(", ")}</div>}
                    {p.include_organic && <div className="text-ink-3">+ organic</div>}
                  </td>
                  <td>{p.status}</td>
                  <td className="text-end tabular-nums">{p.succeeded}</td>
                  <td className="text-end tabular-nums">{p.pending}</td>
                  <td className="text-end tabular-nums">{p.failed}</td>
                  <td className="space-y-1">
                    {manage && (
                      <>
                        <ActionForm action={setPostbackStatusAction.bind(null, org, app, p.id, p.status === "active" ? "paused" : "active")} submitLabel={p.status === "active" ? "Pause" : "Resume"} buttonClass="btn-secondary min-h-8 px-3" className="" />
                        <ActionForm action={setPostbackStatusAction.bind(null, org, app, p.id, "deleted")} submitLabel="Delete" buttonClass="btn-danger" className="" confirm="Delete this postback and its delivery history?" />
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
          <h2 className="h2">New postback</h2>
          <nav className="flex flex-wrap gap-2 text-sm" aria-label="Network">
            {NETWORKS.map((n) => (
              <Link key={n} href={`${base}?${new URLSearchParams({ env: env.type, network: n })}`} className={`rounded-md border px-3 py-1.5 ${n === network ? "border-ink bg-ink text-paper" : "border-line text-ink-2 hover:bg-paper-2"}`}>
                {NETWORK_SPECS[n].label}
              </Link>
            ))}
          </nav>
          {!spec.verified && (
            <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
              The {spec.label} integration follows the network&apos;s published API but is <strong>not verified with the live network</strong> yet. Check the first
              deliveries below and in the network&apos;s event manager before relying on it.
            </p>
          )}
          {spec.credentials.some((c) => c.required) && !canEncrypt && (
            <p className="rounded-lg bg-alert-soft px-3 py-2 text-sm text-alert">
              Credentials can&apos;t be saved on this server yet: INTEGRATIONS_ENCRYPTION_KEY isn&apos;t configured. Until it is, use a custom URL postback.
            </p>
          )}
          <ActionForm action={createPostbackAction.bind(null, org, app)} submitLabel="Save postback" className="space-y-4">
            <input type="hidden" name="environmentId" value={env.id} />
            <input type="hidden" name="network" value={network} />
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block"><span className="label">Name</span><input name="name" className="input" required maxLength={120} defaultValue={network === "custom" ? "" : spec.label} /></label>
              <label className="block"><span className="label">Events</span><input name="events" className="input" required defaultValue="install" placeholder="install, re_engagement, purchase_completed" />
                <span className="help">install, reinstall, re_engagement, and conversion event names from your tracking plan.</span></label>
              <label className="block"><span className="label">Only these sources (optional)</span><input name="sources" className="input" placeholder={network === "custom" ? "tiktok, snapchat" : ""} />
                <span className="help">{network === "custom" ? "Empty: every attributed install." : `Empty: installs attributed to ${spec.label.split(" ")[0]} (by source or click id).`}</span></label>
              {network === "custom" && (
                <label className="flex items-center gap-2 pt-6"><input type="checkbox" name="includeOrganic" /> <span className="text-sm">Also send organic installs and conversions</span></label>
              )}
            </div>
            {network === "custom" && (
              <div className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
                  <label className="block"><span className="label">URL template</span>
                    <input name="urlTemplate" className="input font-mono text-sm" required placeholder="https://example.com/postback?click={click_id}&event={event}&value={revenue}&cur={currency}&ts={timestamp}" /></label>
                  <label className="block"><span className="label">Method</span>
                    <select name="httpMethod" className="input"><option>GET</option><option>POST</option></select></label>
                </div>
                <p className="text-xs text-ink-3">Macros: {POSTBACK_MACROS.map((m) => `{${m}}`).join(" ")}. Values are URL-encoded. POST also sends them as a JSON body.</p>
              </div>
            )}
            {spec.config.length > 0 && (
              <div className="grid gap-3 sm:grid-cols-2">
                {spec.config.map((f) => (
                  <label key={f.key} className="block"><span className="label">{f.label}</span><input name={`config.${f.key}`} className="input" required={f.required} maxLength={500} /></label>
                ))}
              </div>
            )}
            {spec.credentials.length > 0 && (
              <div className="grid gap-3 sm:grid-cols-2">
                {spec.credentials.map((f) => (
                  <label key={f.key} className="block"><span className="label">{f.label}</span><input name={`secret.${f.key}`} type="password" autoComplete="off" className="input" required={f.required} maxLength={4000} /></label>
                ))}
                <p className="help sm:col-span-2">Encrypted at rest and never shown again. To change it, create a new postback and delete this one.</p>
              </div>
            )}
          </ActionForm>
        </section>
      )}

      <section className="card overflow-x-auto p-0">
        <h2 className="h2 px-5 pt-5">Recent deliveries</h2>
        {deliveries.length === 0 ? (
          <p className="px-5 pb-5 pt-2 text-sm text-ink-3">Nothing sent yet.</p>
        ) : (
          <table className="table mt-3">
            <thead><tr><th>Queued</th><th>Postback</th><th>Event</th><th>Status</th><th className="text-end">Attempts</th><th>Last response</th><th>Next try</th></tr></thead>
            <tbody>
              {deliveries.map((d) => (
                <tr key={d.id}>
                  <td className="text-ink-3">{fmt(d.created_at)}</td>
                  <td>{d.postback_name}</td>
                  <td className="font-mono text-xs">{d.event_name}</td>
                  <td>{d.status === "succeeded" ? d.status : <span className={d.status === "pending" ? "" : "text-alert"}>{d.status}</span>}</td>
                  <td className="text-end tabular-nums">{d.attempts}</td>
                  <td className="text-xs break-all text-ink-2">{d.last_status_code ?? ""} {d.last_error ?? ""}</td>
                  <td className="text-ink-3">{d.status === "pending" ? fmt(d.next_attempt_at) : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
