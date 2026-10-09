import { getT } from "@/i18n/server";

/** Audience filter for report forms (a GET param named `cohort`, kept so saved reports and old links still work). */
export async function CohortSelect({ cohorts, value }: { cohorts: { id: string; name: string }[]; value?: string }) {
  if (cohorts.length === 0) return null;
  const t = await getT();
  return (
    <label><span className="label">{t("People in audience")}</span>
      <select name="cohort" className="input" defaultValue={value ?? ""}>
        <option value="">{t("Everyone")}</option>
        {cohorts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
    </label>
  );
}
