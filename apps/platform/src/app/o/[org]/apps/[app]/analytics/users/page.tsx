import Link from "next/link";
import { AnalyticsHeader, param } from "@/components/AnalyticsHeader";
import { searchPeople } from "@/modules/analytics/profiles";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export const metadata = { title: "Users" };


export default async function UsersPage(props: PageProps<"/o/[org]/apps/[app]/analytics/users">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  const when = (d: Date) => new Date(d).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: a.timezone });
  requirePermission(ctx, "users.read");
  const env = await pickEnvironment(environments, sp.env);
  const q = param(sp.q)?.trim() ?? "";
  const res = await searchPeople(ctx, env.id, q, { limit: 50 });
  const path = `/o/${org}/apps/${app}/analytics/users`;
  const profile = (k: "user" | "anon", id: string) => `${path}/profile?${new URLSearchParams({ env: env.type, [k]: id })}`;

  return (
    <div className="space-y-6">
      <AnalyticsHeader title="Users" description="Find one of your app's users by their user ID or an install's anonymous ID, and see everything they did." env={env.type} />

      <form method="get" className="card flex flex-wrap items-end gap-3">
        <input type="hidden" name="env" value={env.type} />
        <label className="min-w-64 flex-1"><span className="label">User ID or anonymous ID</span>
          <input name="q" className="input font-mono" defaultValue={q} maxLength={256} placeholder="Starts with…" autoComplete="off" />
        </label>
        <button className="btn" type="submit">Search</button>
      </form>

      <section className="card overflow-x-auto p-0">
        <h2 className="h2 px-5 pt-4">{q ? "Users" : "Recently seen users"}</h2>
        {res.users.length === 0 ? (
          <p className="px-5 py-4 text-sm text-ink-3">{q ? "No user ID starts with that." : "No identified users in this environment yet. Users appear once your app calls identify()."}</p>
        ) : (
          <table className="table">
            <thead><tr><th className="text-start">User ID</th><th className="text-start">First seen</th><th className="text-start">Last seen</th></tr></thead>
            <tbody>
              {res.users.map((u) => (
                <tr key={u.userId}>
                  <td className="font-mono text-sm"><Link className="underline" href={profile("user", u.userId)}>{u.userId}</Link></td>
                  <td className="whitespace-nowrap">{when(u.firstSeen)}</td>
                  <td className="whitespace-nowrap">{when(u.lastSeen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {q && (
        <section className="card overflow-x-auto p-0">
          <h2 className="h2 px-5 pt-4">Installs</h2>
          {res.installs.length === 0 ? (
            <p className="px-5 py-4 text-sm text-ink-3">No anonymous ID starts with that.</p>
          ) : (
            <table className="table">
              <thead><tr><th className="text-start">Anonymous ID</th><th className="text-start">Platform</th><th className="text-start">Linked users</th><th className="text-start">Last seen</th></tr></thead>
              <tbody>
                {res.installs.map((i) => (
                  <tr key={i.anonymousId}>
                    <td className="font-mono text-sm">
                      <Link className="underline" href={i.linkedUsers.length === 1 ? profile("user", i.linkedUsers[0]) : profile("anon", i.anonymousId)}>{i.anonymousId}</Link>
                    </td>
                    <td>{i.platform ?? "–"}</td>
                    <td className="text-sm">
                      {i.linkedUsers.length === 0 ? <span className="text-ink-3">Anonymous</span>
                        : i.linkedUsers.length === 1 ? <span className="font-mono">{i.linkedUsers[0]}</span>
                        : <span title="Linked to several users, so its anonymous activity isn't merged into any of them">Shared device · {i.linkedUsers.length} users</span>}
                    </td>
                    <td className="whitespace-nowrap">{when(i.lastSeen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
      <p className="text-xs text-ink-3">Search matches the start of an ID, exact matches first. Times are in the app&apos;s timezone ({a.timezone}).</p>
    </div>
  );
}
