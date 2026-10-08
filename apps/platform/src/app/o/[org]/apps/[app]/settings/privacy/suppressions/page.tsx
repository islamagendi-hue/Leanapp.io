import Link from "next/link";
import { addSuppressionAction, removeSuppressionAction } from "@/app/actions/privacy";
import { ActionForm } from "@/components/ActionForm";
import { CodeTabs } from "@/components/CodeTabs";
import { CHANNELS, listSuppressions, suppressionCounts, userKeyOf } from "@/modules/privacy/consent";
import { publicBaseUrl } from "@/server/env";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export const metadata = { title: "Suppression list" };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
const fmt = (d: Date) => new Date(d).toLocaleString("en-GB");
const CHANNEL_INFO: Record<(typeof CHANNELS)[number], string> = {
  marketing: "No marketing messages on any channel",
  push: "No push notifications at all",
  email: "No email at all",
  whatsapp: "No WhatsApp messages at all",
};
const SOURCE_LABEL = { manual: "Dashboard", api: "API", consent: "Consent denied", unsubscribe: "Unsubscribed" } as const;

export default async function SuppressionsPage(props: PageProps<"/o/[org]/apps/[app]/settings/privacy/suppressions">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, environments } = await loadApp(org, app);
  requirePermission(ctx, "privacy.manage");
  const env = await pickEnvironment(environments, sp.env);
  const channel = (CHANNELS as readonly string[]).includes(one(sp.channel) ?? "") ? one(sp.channel) : undefined;
  const q = one(sp.q);
  const userKey = q ? (q.startsWith("anon:") ? q : userKeyOf({ userId: q })!) : undefined;
  const { rows, cursor } = await listSuppressions({ kind: "user", ctx }, env.id, { channel, userKey, limit: 100, before: one(sp.before) });
  const counts = await suppressionCounts(ctx, env.id);
  const base = `/o/${org}/apps/${app}/settings/privacy/suppressions`;
  const api = publicBaseUrl();
  const filterHref = (c?: string) => `${base}?${new URLSearchParams({ env: env.type, ...(c ? { channel: c } : {}), ...(q ? { q } : {}) })}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="h1">Suppression list</h1>
          <p className="mt-1 max-w-2xl text-ink-2">
            Users who must not be messaged, per channel. Automations check this list before every send. Users who deny marketing or push{" "}
            <Link className="underline" href={`/o/${org}/apps/${app}/settings/privacy/consent?env=${env.type}`}>consent</Link> are added automatically and removed when they grant it again.
          </p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {CHANNELS.map((c) => (
          <Link key={c} href={filterHref(channel === c ? undefined : c)} className={`card block ${channel === c ? "ring-2 ring-ink" : ""}`}>
            <p className="font-mono text-[11px] uppercase tracking-wide text-ink-3">{c}</p>
            <p className="mt-1 text-lg font-bold tabular-nums">{counts[c].toLocaleString("en-US")}</p>
            <p className="text-xs text-ink-3">{CHANNEL_INFO[c]}</p>
          </Link>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <section className="card space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h2 className="h2">Suppressed{channel ? ` for ${channel}` : ""}</h2>
            <form method="get" className="flex items-end gap-2">
              <input type="hidden" name="env" value={env.type} />
              {channel && <input type="hidden" name="channel" value={channel} />}
              <input name="q" className="input w-56" placeholder="User ID or anon:<id>" defaultValue={q ?? ""} maxLength={262} />
              <button className="btn-secondary" type="submit">Find</button>
            </form>
          </div>
          {rows.length === 0 ? (
            <p className="text-sm text-ink-3">{q || channel ? "No matching entries." : "Nobody is suppressed in this environment."}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="table">
                <thead><tr><th>User</th><th>Channel</th><th>Source</th><th>Reason</th><th>Added</th><th /></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td className="max-w-[220px] break-all font-mono text-xs">{r.user_key}</td>
                      <td>{r.channel}</td>
                      <td>{SOURCE_LABEL[r.source]}{r.created_by_name ? <span className="text-ink-3"> · {r.created_by_name}</span> : null}</td>
                      <td className="text-ink-2">{r.reason ?? ""}</td>
                      <td className="whitespace-nowrap text-ink-3">{fmt(r.created_at)}</td>
                      <td className="text-end">
                        {r.source === "consent" ? (
                          <span className="text-xs text-ink-3" title="Removed automatically when the user grants consent again">Follows consent</span>
                        ) : (
                          <ActionForm
                            action={removeSuppressionAction.bind(null, org, app, env.id, r.user_key, r.channel)}
                            submitLabel="Remove"
                            buttonClass="btn-secondary"
                            className="inline"
                            confirm={`Allow ${r.channel} messages to ${r.user_key} again?`}
                          />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {cursor && (
            <Link className="text-sm underline" href={`${filterHref(channel)}&before=${encodeURIComponent(cursor)}`}>Older entries</Link>
          )}
        </section>

        <section className="card space-y-3 lg:self-start">
          <h2 className="h2">Add</h2>
          <ActionForm action={addSuppressionAction.bind(null, org, app, env.id)} submitLabel="Suppress" className="space-y-3">
            <label className="block"><span className="label">User ID</span><input name="userId" className="input" maxLength={256} /></label>
            <label className="block"><span className="label">or anonymous ID</span><input name="anonymousId" className="input" maxLength={256} /></label>
            <fieldset className="space-y-1">
              <legend className="label">Channels</legend>
              {CHANNELS.map((c) => (
                <label key={c} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="channel" value={c} defaultChecked={c === "marketing"} /> {c}
                  <span className="text-xs text-ink-3">{CHANNEL_INFO[c]}</span>
                </label>
              ))}
            </fieldset>
            <label className="block"><span className="label">Reason (optional)</span><input name="reason" className="input" maxLength={500} placeholder="e.g. asked support to stop messages" /></label>
          </ActionForm>
        </section>
      </div>

      <section className="card space-y-3">
        <h2 className="h2">From your backend</h2>
        <p className="text-sm text-ink-3">Secret API key of this environment: &quot;manage suppressions&quot; (privacy:write) to add and remove, privacy:read to list.</p>
        <CodeTabs
          preferred="add"
          tabs={[
            {
              key: "add",
              label: "Add",
              code: `curl -X POST ${api}/v1/privacy/suppressions \\
  -H "Authorization: Bearer $LEANAPP_SECRET_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"user_id":"user_123","channels":["marketing","email"],"reason":"unsubscribed"}'`,
            },
            {
              key: "remove",
              label: "Remove",
              code: `curl -X DELETE "${api}/v1/privacy/suppressions?user_id=user_123&channel=email" \\
  -H "Authorization: Bearer $LEANAPP_SECRET_KEY"`,
            },
            {
              key: "list",
              label: "List",
              code: `curl "${api}/v1/privacy/suppressions?channel=marketing&limit=100" \\
  -H "Authorization: Bearer $LEANAPP_SECRET_KEY"`,
            },
          ]}
        />
      </section>
    </div>
  );
}
