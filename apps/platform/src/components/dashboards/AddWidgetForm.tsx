import { addWidgetFromFormAction } from "@/app/actions/dashboards";
import { ActionForm } from "@/components/ActionForm";
import { GROWTH_LABELS } from "@/components/dashboards/WidgetView";
import { RANGES } from "@/modules/analytics/range";
import { FUNNEL_STEP_FIELDS, HEIGHTS, WIDGET_TYPE_LABELS, WIDTHS, type AddWidgetType } from "@/modules/dashboards/form";

const KPI_OPTIONS = [
  ["active_people", "Active people (any event)"],
  ["new_people", "New people"],
  ["all_events", "All events"],
  ["people", "People who did an event"],
  ["events", "Times an event happened"],
] as const;
const GROWTH_METRICS = ["activation_rate", "activated", "people", "core_people", "paying", "d1", "d7", "d30"] as const;
const DEFAULT_SIZE: Record<AddWidgetType, [number, number]> = {
  kpi: [4, 2], trend: [12, 3], funnel: [6, 2], retention: [6, 2], revenue: [12, 3], growth: [4, 2], audience_size: [4, 2],
};

/** The fields of one widget type; sent to the action that builds and validates the config. */
export function AddWidgetForm({ org, app, dashboardId, type, events, audiences }: {
  org: string;
  app: string;
  dashboardId: string;
  type: AddWidgetType;
  events: string[];
  audiences: { id: string; name: string }[];
}) {
  const eventInput = (name: string, label: string, required = true) => (
    <label className="block"><span className="label">{label}</span><input name={name} className="input" list="widget-events" required={required} maxLength={200} /></label>
  );
  const range = (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="block"><span className="label">Range</span>
        <select name="days" className="input" defaultValue="30">{RANGES.map((d) => <option key={d} value={d}>Last {d} days</option>)}</select>
      </label>
      {audiences.length > 0 && (
        <label className="block"><span className="label">People in audience (optional)</span>
          <select name="audience" className="input" defaultValue=""><option value="">Everyone</option>{audiences.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
        </label>
      )}
    </div>
  );
  const [w, h] = DEFAULT_SIZE[type];
  return (
    <ActionForm action={addWidgetFromFormAction.bind(null, org, app, dashboardId, type)} submitLabel={`Add ${WIDGET_TYPE_LABELS[type].toLowerCase()}`}>
      <datalist id="widget-events">{events.map((e) => <option key={e} value={e} />)}</datalist>
      <label className="block"><span className="label">Title (optional)</span><input name="title" className="input" maxLength={80} /></label>

      {type === "kpi" && (
        <>
          <label className="block"><span className="label">Number</span>
            <select name="metric" className="input">{KPI_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          </label>
          {eventInput("event", "Event (for the last two)", false)}
          {range}
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="compare" value="1" defaultChecked /> Compare with the previous period</label>
        </>
      )}
      {type === "trend" && (
        <>
          {eventInput("event", "Event")}
          {range}
        </>
      )}
      {type === "funnel" && (
        <>
          <fieldset className="grid gap-2 sm:grid-cols-2">
            <legend className="label">Steps, in order (at least two)</legend>
            {FUNNEL_STEP_FIELDS.map((f, i) => (
              <input key={f} name={f} className="input" list="widget-events" placeholder={`Step ${i + 1}`} aria-label={`Step ${i + 1}`} required={i < 2} maxLength={200} />
            ))}
          </fieldset>
          <label className="block"><span className="label">Conversion window (days)</span><input name="windowDays" type="number" min={1} max={30} defaultValue={7} className="input" /></label>
          {range}
        </>
      )}
      {type === "retention" && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            {eventInput("startEvent", "Start event")}
            {eventInput("returnEvent", "Return event")}
          </div>
          {range}
        </>
      )}
      {type === "revenue" && range}
      {type === "growth" && (
        <label className="block"><span className="label">Activation number</span>
          <select name="metric" className="input">{GROWTH_METRICS.map((m) => <option key={m} value={m}>{GROWTH_LABELS[m]}</option>)}</select>
        </label>
      )}
      {type === "audience_size" && (
        audiences.length ? (
          <label className="block"><span className="label">Audience</span>
            <select name="audience" className="input" required>{audiences.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
          </label>
        ) : <p className="text-sm text-ink-3">This environment has no audiences yet.</p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block"><span className="label">Width</span>
          <select name="w" className="input" defaultValue={w}>{WIDTHS.map((n) => <option key={n} value={n}>{n === 12 ? "Full width" : `${n} of 12 columns`}</option>)}</select>
        </label>
        <label className="block"><span className="label">Height</span>
          <select name="h" className="input" defaultValue={h}>{HEIGHTS.map((n) => <option key={n} value={n}>{n} {n === 1 ? "row" : "rows"}</option>)}</select>
        </label>
      </div>
    </ActionForm>
  );
}
