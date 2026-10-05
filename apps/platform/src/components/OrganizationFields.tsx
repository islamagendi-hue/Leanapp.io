import { INDUSTRIES } from "@/modules/organizations/service";
import { COUNTRIES, CURRENCIES, TIMEZONES } from "@/modules/organizations/regions";

/** Name, country, industry, timezone and currency inputs shared by organization creation and settings. */
export function OrganizationFields({
  values = { name: "", country: "SA", industry: "", timezone: "Asia/Riyadh", currency: "SAR" },
}: {
  values?: { name: string; country: string; industry: string; timezone: string; currency: string };
}) {
  // Keep a saved value selectable even if it isn't in the default lists.
  const timezones = TIMEZONES.includes(values.timezone) ? TIMEZONES : [values.timezone, ...TIMEZONES];
  const currencies = CURRENCIES.includes(values.currency) ? CURRENCIES : [values.currency, ...CURRENCIES];
  return (
    <>
      <div>
        <label className="label" htmlFor="name">Company name</label>
        <input className="input" id="name" name="name" required minLength={2} maxLength={120} placeholder="ABC Technology" defaultValue={values.name} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="country">Country</label>
          <select className="input" id="country" name="country" defaultValue={values.country}>
            {COUNTRIES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
            <option value="">Other</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="industry">Industry</label>
          <select className="input" id="industry" name="industry" defaultValue={values.industry}>
            <option value="">Choose…</option>
            {INDUSTRIES.map((i) => <option key={i} value={i}>{i.replace(/_/g, " ")}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="timezone">Timezone</label>
          <select className="input" id="timezone" name="timezone" defaultValue={values.timezone}>
            {timezones.map((tz) => <option key={tz}>{tz}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="currency">Default currency</label>
          <select className="input" id="currency" name="currency" defaultValue={values.currency}>
            {currencies.map((c) => <option key={c}>{c}</option>)}
          </select>
        </div>
      </div>
    </>
  );
}
