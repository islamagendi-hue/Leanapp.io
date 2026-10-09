import { getT } from "@/i18n/server";
import { MODEL_LABELS } from "@/modules/implementation/catalog/models";
import { INDUSTRIES } from "@/modules/organizations/service";
import { COUNTRIES, CURRENCIES, TIMEZONES } from "@/modules/organizations/regions";

/** Name, country, industry, timezone and currency inputs shared by organization creation and settings. */
export async function OrganizationFields({
  values = { name: "", country: "SA", industry: "", timezone: "Asia/Riyadh", currency: "SAR" },
}: {
  values?: { name: string; country: string; industry: string; timezone: string; currency: string };
}) {
  const t = await getT();
  // Keep a saved value selectable even if it isn't in the default lists.
  const timezones = TIMEZONES.includes(values.timezone) ? TIMEZONES : [values.timezone, ...TIMEZONES];
  const currencies = CURRENCIES.includes(values.currency) ? CURRENCIES : [values.currency, ...CURRENCIES];
  return (
    <>
      <div>
        <label className="label" htmlFor="name">{t("Company name")}</label>
        <input className="input" id="name" name="name" required minLength={2} maxLength={120} placeholder={t("ABC Technology")} defaultValue={values.name} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="country">{t("Country")}</label>
          <select className="input" id="country" name="country" defaultValue={values.country}>
            {COUNTRIES.map(([code, name]) => <option key={code} value={code}>{t(name)}</option>)}
            <option value="">{t("Other")}</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="industry">{t("Industry")}</label>
          <select className="input" id="industry" name="industry" defaultValue={values.industry}>
            <option value="">{t("Choose…")}</option>
            {INDUSTRIES.map((i) => <option key={i} value={i}>{t(MODEL_LABELS[i])}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="timezone">{t("Timezone")}</label>
          <select className="input" dir="ltr" id="timezone" name="timezone" defaultValue={values.timezone}>
            {timezones.map((tz) => <option key={tz}>{tz}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="currency">{t("Default currency")}</label>
          <select className="input" id="currency" name="currency" defaultValue={values.currency}>
            {currencies.map((c) => <option key={c}>{c}</option>)}
          </select>
        </div>
      </div>
    </>
  );
}
