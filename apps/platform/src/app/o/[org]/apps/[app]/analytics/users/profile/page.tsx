import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AnalyticsHeader, param } from "@/components/AnalyticsHeader";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { getProfile, profileTimeline, type PersonRef, type Profile } from "@/modules/analytics/profiles";
import { NO_CURRENCY } from "@/modules/analytics/revenue";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export const metadata = { title: "User profile" };

const money = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default async function ProfilePage(props: PageProps<"/o/[org]/apps/[app]/analytics/users/profile">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  requirePermission(ctx, "users.read");
  const env = await pickEnvironment(environments, sp.env);
  const userId = param(sp.user);
  const anonymousId = param(sp.anon);
  const ref: PersonRef | null = userId ? { userId } : anonymousId ? { anonymousId } : null;
  const usersPath = `/o/${org}/apps/${app}/analytics/users`;
  const path = `${usersPath}/profile`;
  const link = (q: Record<string, string>) => `${path}?${new URLSearchParams({ env: env.type, ...q })}`;
  if (!ref) redirect(`${usersPath}?env=${env.type}`);

  let p: Profile;
  try {
    const res = await getProfile(ctx, { environmentId: env.id }, ref);
    if ("redirectToUser" in res) redirect(link({ user: res.redirectToUser }));
    p = res;
  } catch (e) {
    if (e instanceof NotFoundError || e instanceof ValidationError) notFound();
    throw e;
  }
  const timeline = await profileTimeline(ctx, { environmentId: env.id }, ref, { cursor: param(sp.before) });
  const when = (d: Date | null) => (d ? new Date(d).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "medium", timeZone: a.timezone }) : "–");
  const self: Record<string, string> = userId ? { user: userId } : { anon: anonymousId! };
  const props_ = Object.entries(p.properties);

  return (
    <div className="space-y-6">
      <AnalyticsHeader
        title={p.userId ?? "Anonymous install"}
        description={p.userId ? "An identified user, with the activity of installs linked only to them." : `Anonymous ID ${p.anonymousId}. Not linked to exactly one user, so its activity stays on this install.`} env={env.type}
      />
      <p className="text-sm"><Link className="underline" href={`${usersPath}?env=${env.type}`}>← All users</Link></p>

      <dl className="card grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="First seen" value={when(p.firstSeen)} />
        <Stat label="Last seen" value={when(p.lastSeen)} />
        <Stat label="Platform" value={p.platform ?? "–"} hint={p.osVersion ? `OS ${p.osVersion}` : undefined} />
        <Stat label="App version" value={p.appVersion ?? "–"} />
        <Stat label="Sessions" value={p.sessionCount.toLocaleString("en-US")} />
        <Stat label="Events" value={p.eventCount.toLocaleString("en-US")} />
      </dl>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card space-y-3">
          <h2 className="h2">Identity</h2>
          {p.installs.length === 0 ? (
            <p className="text-sm text-ink-3">No installs linked yet.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {p.installs.map((i) => (
                <li key={i.anonymousId} className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-mono">{p.userId && !i.stitched ? <Link className="underline" href={link({ anon: i.anonymousId })}>{i.anonymousId}</Link> : i.anonymousId}</span>
                  <span className="text-ink-3">
                    {i.platform ?? ""}
                    {i.linkedUsers.length > 1 && (
                      <span className="pill ms-2 border-warn/40 text-warn" title={`Linked to ${i.linkedUsers.join(", ")}`}>Shared device · not merged</span>
                    )}
                    {p.userId && i.stitched && <span className="pill ms-2 border-accent/40 text-accent">Merged</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {p.installs.some((i) => i.linkedUsers.length > 1) && (
            <p className="text-xs text-ink-3">
              A shared device was used by several users ({[...new Set(p.installs.flatMap((i) => i.linkedUsers.length > 1 ? i.linkedUsers : []))].map((u, k) => (
                <span key={u}>{k > 0 && ", "}{u === p.userId ? u : <Link className="underline" href={link({ user: u })}>{u}</Link>}</span>
              ))}). Its anonymous activity can&apos;t be attributed to any one of them, so it isn&apos;t merged.
            </p>
          )}
        </section>

        <section className="card space-y-3">
          <h2 className="h2">Revenue</h2>
          {p.revenue.length === 0 ? (
            <p className="text-sm text-ink-3">No revenue events.</p>
          ) : (
            <table className="table">
              <thead><tr><th className="text-start">Currency</th><th className="text-end">Net</th><th className="text-end">Refunds</th><th className="text-end">Transactions</th></tr></thead>
              <tbody>
                {p.revenue.map((r) => (
                  <tr key={r.currency}>
                    <td>{r.currency === NO_CURRENCY ? "No currency" : r.currency}</td>
                    <td className="text-end tabular-nums font-medium">{money(r.net)}</td>
                    <td className="text-end tabular-nums">{r.refunds ? `−${money(r.refunds)}` : ""}</td>
                    <td className="text-end tabular-nums">{r.transactions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="text-xs text-ink-3">All time, per currency (no conversion).</p>
        </section>
      </div>

      <section className="card space-y-3">
        <h2 className="h2">{p.userId ? "User properties" : "Anonymous traits"}</h2>
        {props_.length === 0 ? (
          <p className="text-sm text-ink-3">None set. Properties come from identify() calls.</p>
        ) : (
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
            {props_.map(([k, v]) => (
              <div key={k} className="flex min-w-0 gap-2">
                <dt className="font-mono text-ink-3">{k}</dt>
                <dd className="min-w-0 truncate font-mono" title={typeof v === "string" ? v : JSON.stringify(v)}>{typeof v === "string" ? v : JSON.stringify(v)}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      <section className="card overflow-x-auto p-0">
        <h2 className="h2 px-5 pt-4">Activity</h2>
        {timeline.events.length === 0 ? (
          <p className="px-5 py-4 text-sm text-ink-3">No events{param(sp.before) ? " before this point" : ""}.</p>
        ) : (
          <table className="table">
            <thead><tr><th className="text-start">Time ({a.timezone})</th><th className="text-start">Event</th><th className="text-start">Properties</th><th className="text-start">Platform</th></tr></thead>
            <tbody>
              {timeline.events.map((e) => (
                <tr key={e.id} className="align-top">
                  <td className="whitespace-nowrap tabular-nums">{when(e.timestamp)}</td>
                  <td>
                    <span className="font-mono text-sm">{e.name}</span>
                    {e.type !== "track" && <span className="pill ms-2 border-line text-ink-3">{e.type}</span>}
                    {e.sentAs && <div className="text-xs text-ink-3">sent as {e.sentAs}</div>}
                    {p.userId && !e.userId && <div className="text-xs text-ink-3">before sign-in · {e.anonymousId}</div>}
                  </td>
                  <td className="max-w-md">
                    {Object.keys(e.properties).length > 0 && <code className="block truncate font-mono text-xs text-ink-2" title={JSON.stringify(e.properties)}>{JSON.stringify(e.properties)}</code>}
                  </td>
                  <td className="whitespace-nowrap text-sm text-ink-2">{[e.platform, e.appVersion].filter(Boolean).join(" ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="flex gap-3 px-5 py-3 text-sm">
          {param(sp.before) && <Link className="underline" href={link(self)}>Newest</Link>}
          {timeline.nextCursor && <Link className="underline" href={link({ ...self, before: timeline.nextCursor })}>Older events →</Link>}
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-ink-3">{label}</dt>
      <dd className="truncate text-sm font-medium" title={value}>{value}</dd>
      {hint && <dd className="text-xs text-ink-3">{hint}</dd>}
    </div>
  );
}
