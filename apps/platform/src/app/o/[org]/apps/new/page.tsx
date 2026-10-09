import { createAppAction } from "@/app/actions/apps";
import { ActionForm } from "@/components/ActionForm";
import { getT } from "@/i18n/server";
import { msg } from "@/i18n/translate";
import { APP_PLATFORMS } from "@/modules/apps/service";
import { requirePermission, requireTenant } from "@/server/session";

export async function generateMetadata() {
  const t = await getT();
  return { title: t("New app") };
}

const LABELS: Record<string, string> = { android: "Android", ios: "iOS", react_native: "React Native", flutter: "Flutter", web: msg("Web"), backend: msg("Backend / server") };

export default async function NewAppPage(props: PageProps<"/o/[org]/apps/new">) {
  const { org } = await props.params;
  const ctx = await requireTenant(org);
  requirePermission(ctx, "apps.create");
  const t = await getT();
  return (
    <main className="mx-auto max-w-xl px-4 py-8">
      <h1 className="h1">{t("Create an app")}</h1>
      <p className="mt-1 text-ink-2">{t("We create Development, Staging and Production environments, each with its own SDK key. Production data never mixes with test data.")}</p>
      <div className="card mt-6">
        <ActionForm action={createAppAction.bind(null, org)} submitLabel={t("Create app and continue")}>
          <div>
            <label className="label" htmlFor="name">{t("App name")}</label>
            <input className="input" id="name" name="name" required minLength={2} placeholder={t("Consumer App")} />
          </div>
          <div>
            <label className="label" htmlFor="description">{t("What is it?")} <span className="muted">{t("(optional)")}</span></label>
            <input className="input" id="description" name="description" placeholder={t("Food delivery app for Riyadh and Jeddah")} />
          </div>
          <fieldset>
            <legend className="label">{t("Platforms")}</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {APP_PLATFORMS.map((p) => (
                <label key={p} className="flex min-h-10 items-center gap-2 rounded-lg border border-line px-3 text-sm has-checked:border-accent has-checked:bg-accent-soft">
                  <input type="checkbox" name="platforms" value={p} defaultChecked={p === "android" || p === "ios"} />
                  {t(LABELS[p])}
                </label>
              ))}
            </div>
          </fieldset>
          <div>
            <label className="label" htmlFor="currency">{t("Reporting currency")}</label>
            <input className="input" id="currency" name="currency" placeholder={t("Organization default")} maxLength={3} />
          </div>
        </ActionForm>
      </div>
    </main>
  );
}
