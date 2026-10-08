import Link from "next/link";
import { setEnvironmentStatusAction } from "@/app/actions/apps";
import { ActionForm } from "@/components/ActionForm";
import { can } from "@/modules/rbac/authorize";
import { loadApp } from "@/server/session";

export const metadata = { title: "Environments" };

const ABOUT: Record<string, string> = {
  development: "For builds on your machine and the event debugger.",
  staging: "For QA and pre-release builds.",
  production: "Your live app. Reports open on it by default.",
};

export default async function EnvironmentsPage(props: PageProps<"/o/[org]/apps/[app]/settings/project/environments">) {
  const { org, app } = await props.params;
  const { ctx, app: a, environments } = await loadApp(org, app);
  const manage = can(ctx.role, "apps.update") && a.status === "active";
  const keys = can(ctx.role, "credentials.read");
  return (
    <div className="space-y-6">
      <div>
        <h1 className="h1">Environments</h1>
        <p className="mt-1 text-ink-2">Each environment has its own SDK keys and data; test events never mix with production.</p>
      </div>
      <ul className="max-w-2xl space-y-3">
        {environments.map((e) => {
          const paused = e.status === "disabled";
          return (
            <li key={e.id} className="card flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="flex items-center gap-2 font-medium">
                  {e.name}
                  <span className={`pill ${paused ? "border-warn/40 text-warn" : "border-line text-ink-3"}`}>{paused ? "Paused" : "Active"}</span>
                </p>
                <p className="mt-1 text-sm text-ink-3">
                  {paused ? "Its SDK keys are refused, so it receives no events. Data is kept." : ABOUT[e.type]}
                  {keys && <> <Link className="underline underline-offset-2" href={`/o/${org}/apps/${app}/settings/dev-ops/sdk?env=${e.type}`}>SDK keys</Link></>}
                </p>
              </div>
              {manage && e.type !== "production" && (
                <ActionForm
                  action={setEnvironmentStatusAction.bind(null, org, e.id, paused ? "active" : "disabled")}
                  submitLabel={paused ? "Resume" : "Pause"}
                  pendingLabel={paused ? "Resuming…" : "Pausing…"}
                  className="flex items-center gap-2"
                  buttonClass="btn-secondary"
                  confirm={paused ? undefined : `Pause ${e.name}? Events sent to it are refused until you resume it.`}
                />
              )}
            </li>
          );
        })}
      </ul>
      <p className="max-w-2xl text-sm text-ink-3">Production can&apos;t be paused on its own; archive the project in General to stop it.</p>
    </div>
  );
}
