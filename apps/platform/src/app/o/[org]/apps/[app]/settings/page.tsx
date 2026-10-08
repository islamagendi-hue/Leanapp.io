import Link from "next/link";
import { settingsMenu } from "@/modules/navigation/menu";
import { loadApp } from "@/server/session";

export const metadata = { title: "Settings" };

/** Settings home: every section the member can open, grouped as in the side menu. */
export default async function SettingsHome(props: PageProps<"/o/[org]/apps/[app]/settings">) {
  const { org, app } = await props.params;
  const { ctx } = await loadApp(org, app);
  const menu = settingsMenu(ctx.role, org, `/o/${org}/apps/${app}`);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="h1">Settings</h1>
        <p className="mt-1 text-ink-2">Workspace and project settings, and everything developers need to connect and configure the app.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {menu.map((g) => (
          <section key={g.label} className="card">
            <h2 className="h2">{g.label}</h2>
            <ul className="mt-3 space-y-1.5 text-sm">
              {g.items.filter((i) => !i.sub).map((i) => (
                <li key={i.label}>
                  {i.href ? (
                    <Link className="underline-offset-2 hover:underline" href={i.href}>{i.label}</Link>
                  ) : (
                    <span className="text-ink-3">{i.label} <span className="pill ms-1 border-line text-[10px]">Soon</span></span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
