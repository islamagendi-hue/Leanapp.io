/** Cohort filter for report forms (a GET param named `cohort`). */
export function CohortSelect({ cohorts, value }: { cohorts: { id: string; name: string }[]; value?: string }) {
  if (cohorts.length === 0) return null;
  return (
    <label><span className="label">People in cohort</span>
      <select name="cohort" className="input" defaultValue={value ?? ""}>
        <option value="">Everyone</option>
        {cohorts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
    </label>
  );
}
