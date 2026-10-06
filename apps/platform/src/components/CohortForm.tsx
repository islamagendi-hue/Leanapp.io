import { ActionForm, type FormState } from "@/components/ActionForm";
import { formDefaults } from "@/modules/analytics/cohort-form";
import { COHORT_LAST_DAYS, PROPERTY_OP_LABELS, PROPERTY_OPS, type CohortDefinition } from "@/modules/analytics/sql";

/** Create / edit a cohort. Works without JavaScript: leave a condition's name empty to skip it. */
export function CohortForm({ action, events, submitLabel, name = "", description = "", definition }: {
  action: (state: FormState, form: FormData) => Promise<FormState>;
  events: string[];
  submitLabel: string;
  name?: string;
  description?: string | null;
  definition?: CohortDefinition;
}) {
  const d = formDefaults(definition);
  return (
    <ActionForm action={action} submitLabel={submitLabel} className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block"><span className="label">Name</span><input name="name" className="input" defaultValue={name} maxLength={100} required /></label>
        <label className="block"><span className="label">Description (optional)</span><input name="description" className="input" defaultValue={description ?? ""} maxLength={500} /></label>
      </div>

      <fieldset className="space-y-3 rounded-lg border border-line p-4">
        <legend className="px-1 text-sm font-medium">People who did an event</legend>
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-48 flex-1"><span className="label">Event</span>
            <input name="event" className="input font-mono" list="cohort-events" defaultValue={d.event} maxLength={200} placeholder="Leave empty to skip" />
            <datalist id="cohort-events">{events.map((e) => <option key={e} value={e} />)}</datalist>
          </label>
          <label><span className="label">At least</span>
            <span className="flex items-center gap-2"><input name="minCount" type="number" min={1} max={10000} className="input w-24" defaultValue={d.minCount} /><span className="text-sm text-ink-2">times</span></span>
          </label>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-h-10 items-center gap-2 text-sm"><input type="radio" name="rangeKind" value="last" defaultChecked={d.rangeKind === "last"} /> In the last</label>
          <select name="lastDays" className="input w-32" defaultValue={d.lastDays} aria-label="Days">
            {COHORT_LAST_DAYS.map((n) => <option key={n} value={n}>{n === 1 ? "1 day" : `${n} days`}</option>)}
          </select>
          <label className="flex min-h-10 items-center gap-2 text-sm"><input type="radio" name="rangeKind" value="between" defaultChecked={d.rangeKind === "between"} /> Between</label>
          <input type="date" name="from" className="input w-40" defaultValue={d.from} aria-label="From" />
          <span className="pb-2 text-sm text-ink-2">and</span>
          <input type="date" name="to" className="input w-40" defaultValue={d.to} aria-label="To" />
        </div>
        <PropertyRow prefix="ep" label="Only events where property" values={d.ep} />
      </fieldset>

      <fieldset className="space-y-3 rounded-lg border border-line p-4">
        <legend className="px-1 text-sm font-medium">And whose user property</legend>
        <PropertyRow prefix="up" label="User property" values={d.up} />
        <p className="help">From identify() traits. With both conditions, a person must match both.</p>
      </fieldset>
    </ActionForm>
  );
}

function PropertyRow({ prefix, label, values }: { prefix: string; label: string; values: { name: string; op: string; value: string } }) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <label><span className="label">{label}</span><input name={`${prefix}Name`} className="input w-44 font-mono" defaultValue={values.name} maxLength={64} placeholder="optional" /></label>
      <label><span className="label">Condition</span>
        <select name={`${prefix}Op`} className="input w-36" defaultValue={values.op}>{PROPERTY_OPS.map((o) => <option key={o} value={o}>{PROPERTY_OP_LABELS[o]}</option>)}</select>
      </label>
      <label><span className="label">Value</span><input name={`${prefix}Value`} className="input w-44" defaultValue={values.value} maxLength={200} /></label>
    </div>
  );
}
