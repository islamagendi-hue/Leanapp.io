import Link from "next/link";
import { environmentHasEvents } from "@/modules/apps/service";
import { can } from "@/modules/rbac/authorize";
import type { Permission } from "@/modules/rbac/permissions";
import { loadApp } from "@/server/session";

export const metadata = { title: "Overview" };

/**
 * A project's home. Until production receives its first event it says so and points to
 * Settings → Dev Ops → Get started; the setup checklist itself is no longer the home page.
 */
export default async function OverviewPage(props: PageProps<"/o/[org]/apps/[app]">) {
  const { org, app } = await props.params;
  const { ctx, app: a, environments } = await loadApp(org, app);
  const base = `/o/${org}/apps/${app}`;
  const production = environments.find((e) => e.type === "production");
  const live = production ? await environmentHasEvents(ctx, production.id) : false;

  const sections: { label: string; href: string; text: string; perm: Permission }[] = [
    { label: "Events & trends", href: `${base}/analytics/events`, text: "How often each event happens and how many people do it.", perm: "analytics.read" },
    { label: "Funnels", href: `${base}/analytics/funnels`, text: "Conversion through ordered steps.", perm: "analytics.read" },
    { label: "Retention", href: `${base}/analytics/retention`, text: "Who comes back after day 1, 7 and 30.", perm: "analytics.read" },
    { label: "Revenue", href: `${base}/analytics/revenue`, text: "Net revenue, ARPU and paying people.", perm: "analytics.read" },
    { label: "Activation", href: `${base}/growth`, text: "Who activates, keeps coming back and pays.", perm: "growth.read" },
    { label: "Users", href: `${base}/analytics/users`, text: "One person's profile and full timeline.", perm: "users.read" },
    { label: "Audiences", href: `${base}/engage/audiences`, text: "Reusable groups of people to analyse and reach.", perm: "audiences.read" },
  ];
  const visible = sections.filter((s) => can(ctx.role, s.perm));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="h1">Overview</h1>
        <p className="mt-1 text-ink-2">{a.name}{a.description ? `: ${a.description}` : ""}</p>
      </div>

      {!live && (
        <section className="card flex flex-wrap items-center justify-between gap-4 border-accent/40 bg-accent-soft">
          <div>
            <h2 className="h2">Connect your app</h2>
            <p className="mt-1 max-w-xl text-sm text-ink-2">
              Production hasn&apos;t received any events yet. Install the SDK and send your first event; your reports fill in as data arrives.
            </p>
          </div>
          <Link href={`${base}/settings/dev-ops/get-started`} className="btn">Get started</Link>
        </section>
      )}

      {visible.length > 0 && (
        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((s) => (
            <Link key={s.href} href={s.href} className="card block hover:border-line-strong">
              <p className="font-medium">{s.label}</p>
              <p className="mt-1 text-sm text-ink-3">{s.text}</p>
            </Link>
          ))}
        </section>
      )}
    </div>
  );
}
