import Link from "next/link";
import { setEnvironmentStatusAction } from "@/app/actions/apps";
import { ActionForm } from "@/components/ActionForm";
import { getT } from "@/i18n/server";
import { msg } from "@/i18n/translate";
import { can } from "@/modules/rbac/authorize";
import { loadApp } from "@/server/session";

export async function generateMetadata() {
  const t = await getT();
  return { title: t("Environments") };
}

const ABOUT: Record<string, string> = {
  development: msg("For builds on your machine and the event debugger."),
  staging: msg("For QA and pre-release builds."),
  production: msg("Your live app. Reports open on it by default."),
};

export default async function EnvironmentsPage(props: PageProps<"/o/[org]/apps/[app]/settings/project/environments">) {
  const { org, app } = await props.params;
  const { ctx, app: a, environments } = await loadApp(org, app);
  const manage = can(ctx.role, "apps.update") && a.status === "active";
  const keys = can(ctx.role, "credentials.read");
  const t = await getT();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="h1">{t("Environments")}</h1>
        <p className="mt-1 text-ink-2">{t("Each environment has its own SDK keys and data; test events never mix with production.")}</p>
      </div>
      <ul className="max-w-2xl space-y-3">
        {environments.map((e) => {
          const paused = e.status === "disabled";
          return (
            <li key={e.id} className="card flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="flex items-center gap-2 font-medium">
                  {t(e.name)}
                  <span className={`pill ${paused ? "border-warn/40 text-warn" : "border-line text-ink-3"}`}>{paused ? t("Paused") : t("Active")}</span>
                </p>
                <p className="mt-1 text-sm text-ink-3">
                  {paused ? t("Its SDK keys are refused, so it receives no events. Data is kept.") : t(ABOUT[e.type])}
                  {keys && <> <Link className="underline underline-offset-2" href={`/o/${org}/apps/${app}/settings/dev-ops/sdk?env=${e.type}`}>{t("SDK keys")}</Link></>}
                </p>
              </div>
              {manage && e.type !== "production" && (
                <ActionForm
                  action={setEnvironmentStatusAction.bind(null, org, e.id, paused ? "active" : "disabled")}
                  submitLabel={paused ? t("Resume") : t("Pause")}
                  pendingLabel={paused ? t("Resuming…") : t("Pausing…")}
                  className="flex items-center gap-2"
                  buttonClass="btn-secondary"
                  confirm={paused ? undefined : t("Pause {name}? Events sent to it are refused until you resume it.", { name: t(e.name) })}
                />
              )}
            </li>
          );
        })}
      </ul>
      <p className="max-w-2xl text-sm text-ink-3">{t("Production can't be paused on its own; archive the project in General to stop it.")}</p>
    </div>
  );
}
