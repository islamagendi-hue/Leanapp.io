import Link from "next/link";
import { listApps, listArchivedApps } from "@/modules/apps/service";
import { can } from "@/modules/rbac/authorize";
import { requireTenant } from "@/server/session";

export default async function OrgHome(props: PageProps<"/o/[org]">) {
  const { org } = await props.params;
  const ctx = await requireTenant(org);
  const [apps, archived] = await Promise.all([listApps(ctx), listArchivedApps(ctx)]);
  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="h1">Projects</h1>
          <p className="mt-1 text-ink-2">Each project has isolated Development, Staging and Production environments.</p>
        </div>
        {can(ctx.role, "apps.create") && <Link href={`/o/${org}/apps/new`} className="btn">New project</Link>}
      </div>
      {apps.length === 0 ? (
        <div className="card mt-8 text-center">
          <p className="text-ink-2">No projects yet.</p>
          {can(ctx.role, "apps.create") && <Link href={`/o/${org}/apps/new`} className="btn mt-4">Create your first project</Link>}
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
      {archived.length > 0 && (
        <details className="mt-8">
          <summary className="cursor-pointer text-sm text-ink-2">Archived projects ({archived.length})</summary>
          <ul className="mt-3 space-y-2">
            {archived.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-4 rounded-lg border border-line px-4 py-2 text-sm">
                <span>{a.name}</span>
                <Link href={`/o/${org}/apps/${a.slug}/settings/project`} className="text-ink-2 underline underline-offset-2">
                  {can(ctx.role, "apps.delete") ? "Restore or view" : "View"}
                </Link>
              </li>
            ))}
          </ul>
        </details>
      )}
    </main>
  );
}
