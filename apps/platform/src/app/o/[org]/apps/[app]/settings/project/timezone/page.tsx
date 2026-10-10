import { updateAppLocaleAction } from "@/app/actions/apps";
import { ActionForm } from "@/components/ActionForm";
import { CURRENCIES, TIMEZONES } from "@/modules/organizations/regions";
import { getT } from "@/i18n/server";
import { can } from "@/modules/rbac/authorize";
import { loadApp } from "@/server/session";

export async function generateMetadata() {
  const t = await getT();
  return { title: t("Timezone & currency") };
}

export default async function ProjectLocalePage(props: PageProps<"/o/[org]/apps/[app]/settings/project/timezone">) {
  const { org, app } = await props.params;
  const { ctx, app: a } = await loadApp(org, app);
  const t = await getT();
  // Keep the saved values selectable even if they aren't in the default lists.
  const timezones = TIMEZONES.includes(a.timezone) ? TIMEZONES : [a.timezone, ...TIMEZONES];
  const currencies = CURRENCIES.includes(a.default_currency) ? CURRENCIES : [a.default_currency, ...CURRENCIES];
  return (
    <div className="space-y-6">
      <div>
        <h1 className="h1">{t("Timezone & currency")}</h1>
        <p className="mt-1 text-ink-2">{t("Reports group days in this timezone and show revenue in this currency. Events keep their own timestamps and currencies.")}</p>
      </div>
      <section className="card max-w-2xl">
        {can(ctx.role, "apps.update") ? (
          <ActionForm action={updateAppLocaleAction.bind(null, org, a.id)} submitLabel={t("Save changes")} pendingLabel={t("Saving…")}>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="timezone">{t("Timezone")}</label>
                <select dir="ltr" className="input" id="timezone" name="timezone" defaultValue={a.timezone}>
                  {timezones.map((tz) => <option key={tz}>{tz}</option>)}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="currency">{t("Reporting currency")}</label>
                <select className="input" id="currency" name="currency" defaultValue={a.default_currency}>
                  {currencies.map((c) => <option key={c}>{c}</option>)}
                </select>
              </div>
            </div>
          </ActionForm>
        ) : (
          <dl className="grid grid-cols-[140px_1fr] gap-y-2 text-sm">
            <dt className="text-ink-3">{t("Timezone")}</dt><dd>{a.timezone}</dd>
            <dt className="text-ink-3">{t("Currency")}</dt><dd>{a.default_currency}</dd>
          </dl>
        )}
      </section>
    </div>
  );
}
