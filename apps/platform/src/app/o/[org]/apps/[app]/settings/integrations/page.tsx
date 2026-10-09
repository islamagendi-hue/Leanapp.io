import Link from "next/link";
import { getT } from "@/i18n/server";
import { INTEGRATIONS, type IntegrationState } from "@/modules/integrations/catalog";
import { can } from "@/modules/rbac/authorize";
import { SUPPORT_EMAIL } from "@/modules/support/contact";
import { loadApp } from "@/server/session";

export async function generateMetadata() {
  return { title: (await getT())("Integrations") };
}

export default async function IntegrationsPage(props: PageProps<"/o/[org]/apps/[app]/settings/integrations">) {
  const { org, app } = await props.params;
  const { ctx } = await loadApp(org, app);
  const base = `/o/${org}/apps/${app}`;
  const t = await getT();
  const badge: Record<IntegrationState, { label: string; cls: string }> = {
    live: { label: t("Live"), cls: "border-accent text-accent-ink" },
    beta: { label: t("Beta"), cls: "border-warn/40 text-warn" },
    soon: { label: t("Soon"), cls: "border-line text-ink-3" },
  };
  return (
    <div className="space-y-8">
      <div>
        <h1 className="h1">{t("Integrations")}</h1>
        <p className="mt-1 max-w-2xl text-ink-2">{t("Everything this project can connect to, and where to set it up. Beta means built but not yet verified against the live service.")}</p>
      </div>
      {INTEGRATIONS.map((g) => (
        <section key={g.title} aria-labelledby={`int-${g.title}`}>
          <h2 id={`int-${g.title}`} className="mb-3 font-bold">{t(g.title)}</h2>
          <ul className="grid gap-3 md:grid-cols-2">
            {g.items.map((i) => {
              const open = i.path && (!i.perm || can(ctx.role, i.perm));
              return (
                <li key={i.id} aria-label={t(i.name)} className="card flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{t(i.name)}</span>
                    <span className={`pill ${badge[i.state].cls}`}>{badge[i.state].label}</span>
                  </div>
                  <p className="text-sm text-ink-2">{t(i.what)}</p>
                  <div className="mt-auto pt-1 text-sm">
                    {open ? (
                      <Link href={`${base}/${i.path}`} className="font-medium text-accent-ink underline">{t("Set up")}</Link>
                    ) : i.state === "soon" ? (
                      <a href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(`Integration request: ${i.name}`)}`} className="text-ink-2 underline">{t("Ask for it")}</a>
                    ) : (
                      <span className="text-ink-3">{t("Ask an admin to set this up.")}</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
