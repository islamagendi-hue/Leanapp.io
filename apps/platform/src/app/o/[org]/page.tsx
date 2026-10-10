import Link from "next/link";
import { redirect } from "next/navigation";
import { listApps, listArchivedApps } from "@/modules/apps/service";
import { getT } from "@/i18n/server";
import { fmtNumber } from "@/i18n/translate";
import { can } from "@/modules/rbac/authorize";
import { requireTenant } from "@/server/session";

export default async function OrgHome(props: PageProps<"/o/[org]">) {
  const { org } = await props.params;
  const ctx = await requireTenant(org);
  const [apps, archived] = await Promise.all([listApps(ctx), listArchivedApps(ctx)]);
  // Most accounts have one app: open it instead of a list of one.
  if (apps.length === 1 && archived.length === 0) redirect(`/o/${org}/apps/${apps[0].slug}`);
  const t = await getT();
  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="h1">{t("Projects")}</h1>
          <p className="mt-1 text-ink-2">{t("Each project has isolated Development, Staging and Production environments.")}</p>
        </div>
        {can(ctx.role, "apps.create") && <Link href={`/o/${org}/apps/new`} className="btn">{t("New project")}</Link>}
      </div>
      {apps.length === 0 ? (
        <div className="card mt-8 text-center">
          <p className="text-ink-2">{t("No projects yet.")}</p>
          {can(ctx.role, "apps.create") && <Link href={`/o/${org}/apps/new`} className="btn mt-4">{t("Create your first project")}</Link>}
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
                <p className="mt-3 font-mono text-xs text-ink-3" dir="ltr">{a.platforms.join(" · ") || t("no platforms")}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {archived.length > 0 && (
        <details className="mt-8">
          <summary className="cursor-pointer text-sm text-ink-2">{t("Archived projects ({n})", { n: fmtNumber(archived.length) })}</summary>
          <ul className="mt-3 space-y-2">
            {archived.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-4 rounded-lg border border-line px-4 py-2 text-sm">
                <span>{a.name}</span>
                <Link href={`/o/${org}/apps/${a.slug}/settings/project`} className="text-ink-2 underline underline-offset-2">
                  {can(ctx.role, "apps.delete") ? t("Restore or view") : t("View")}
                </Link>
              </li>
            ))}
          </ul>
        </details>
      )}
    </main>
  );
}
