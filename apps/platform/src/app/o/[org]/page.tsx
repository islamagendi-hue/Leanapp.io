import Link from "next/link";
import { listApps } from "@/modules/apps/service";
import { can } from "@/modules/rbac/authorize";
import { requireTenant } from "@/server/session";

export default async function OrgHome(props: PageProps<"/o/[org]">) {
  const { org } = await props.params;
  const ctx = await requireTenant(org);
  const apps = await listApps(ctx);
  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="h1">Apps</h1>
          <p className="mt-1 text-ink-2">Each app has isolated Development, Staging and Production environments.</p>
        </div>
        {can(ctx.role, "apps.create") && <Link href={`/o/${org}/apps/new`} className="btn">New app</Link>}
      </div>
      {apps.length === 0 ? (
        <div className="card mt-8 text-center">
          <p className="text-ink-2">No apps yet.</p>
          {can(ctx.role, "apps.create") && <Link href={`/o/${org}/apps/new`} className="btn mt-4">Create your first app</Link>}
        </div>
      ) : (
        <ul className="mt-8 grid gap-4 sm:grid-cols-2">
          {apps.map((a) => (
            <li key={a.id}>
              <Link href={`/o/${org}/apps/${a.slug}`} className="card block transition hover:border-line-strong">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-lg font-bold">{a.name}</span>
                  <span className="pill border-line text-ink-3">{a.default_currency}</span>
                </div>
                {a.description && <p className="mt-1 text-sm text-ink-2">{a.description}</p>}
                <p className="mt-3 font-mono text-xs text-ink-3">{a.platforms.join(" · ") || "no platforms"}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
