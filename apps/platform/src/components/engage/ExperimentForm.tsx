"use client";

import { useState } from "react";
import { ActionForm, type FormState } from "@/components/ActionForm";
import { useT } from "@/i18n/client";
import { PROPERTY_OP_LABELS, PROPERTY_OPS } from "@/modules/analytics/sql";
import { MAX_VARIANTS, WINDOW_DAYS, type ExperimentForm as Values } from "@/modules/experiments/definition";

/** Name and hypothesis → variants and weights → who takes part → goal → secondary metric. */
export function ExperimentForm({ action, initial, audiences, events, submitLabel }: {
  action: (state: FormState, form: FormData) => Promise<FormState>;
  initial: Values;
  audiences: { id: string; name: string; status: string; member_count: number }[];
  events: string[];
  submitLabel: string;
}) {
  const t = useT();
  const v = (k: string) => initial[k] ?? "";
  const filled = Array.from({ length: MAX_VARIANTS }, (_, i) => i).filter((i) => i < 2 || v(`variantKey${i}`)).length;
  const [rows, setRows] = useState(filled);
  const [secondary, setSecondary] = useState(v("secondaryKind") || "none");
  const [filterOp, setFilterOp] = useState(v("goalFilterOp") || "eq");
  const noValue = filterOp === "exists" || filterOp === "not_exists";

  return (
    <ActionForm action={action} submitLabel={submitLabel}>
      <datalist id="experiment-events">{events.map((e) => <option key={e} value={e} />)}</datalist>
      <div className="grid max-w-3xl gap-3 sm:grid-cols-2">
        <label className="block"><span className="label">{t("Experiment name")}</span><input name="name" className="input" required minLength={2} maxLength={80} defaultValue={v("name")} /></label>
        <label className="block"><span className="label">{t("Key used in your app's code")}</span><input name="key" className="input font-mono" dir="ltr" required pattern="[a-z][a-z0-9_]{1,59}" maxLength={60} placeholder="checkout_button" defaultValue={v("key")} /></label>
      </div>
      <label className="block max-w-3xl"><span className="label">{t("Hypothesis (optional)")}</span>
        <textarea name="hypothesis" className="input min-h-20" maxLength={1000} placeholder={t("If we show the price on the button, more people will finish checkout.")} defaultValue={v("hypothesis")} />
      </label>

      <fieldset className="space-y-2">
        <legend className="h2">{t("1. Variants")}</legend>
        <p className="text-sm text-ink-2">{t("The first row is the control. Weights set each variant's share of traffic.")}</p>
        <div className="overflow-x-auto">
          <table className="table max-w-3xl">
            <thead><tr><th>{t("Variant")}</th><th>{t("Key")}</th><th>{t("Name")}</th><th>{t("Weight")}</th><th /></tr></thead>
            <tbody>
              {Array.from({ length: MAX_VARIANTS }, (_, i) => (
                <tr key={i} hidden={i >= rows}>
                  <td className="text-sm text-ink-2">{i === 0 ? t("Control") : t("Variant {n}", { n: i })}</td>
                  <td><input name={`variantKey${i}`} className="input w-36 font-mono" dir="ltr" aria-label={t("Variant {n} key", { n: i + 1 })} maxLength={40} required={i < 2} disabled={i >= rows} defaultValue={v(`variantKey${i}`)} /></td>
                  <td><input name={`variantName${i}`} className="input w-44" aria-label={t("Variant {n} name", { n: i + 1 })} maxLength={60} disabled={i >= rows} defaultValue={v(`variantName${i}`)} /></td>
                  <td><input name={`variantWeight${i}`} type="number" min={1} max={1000} className="input w-24" aria-label={t("Variant {n} weight", { n: i + 1 })} required={i < 2} disabled={i >= rows} defaultValue={v(`variantWeight${i}`) || "50"} /></td>
                  <td>{i >= 2 && i === rows - 1 && <button type="button" className="btn-secondary text-xs" onClick={() => setRows(rows - 1)}>{t("Remove")}</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows < MAX_VARIANTS && <button type="button" className="btn-secondary" onClick={() => setRows(rows + 1)}>{t("Add a variant")}</button>}
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="h2">{t("2. Who takes part")}</legend>
        <div className="flex flex-wrap items-end gap-3">
          <label className="block"><span className="label">{t("Audience")}</span>
            <select name="audienceId" className="input max-w-md" defaultValue={v("audienceId")}>
              <option value="">{t("Everyone who opens the app")}</option>
              {audiences.map((a) => (
                <option key={a.id} value={a.id}>{a.status === "active" ? t("{name} ({n} people)", { name: a.name, n: a.member_count.toLocaleString("en-US") }) : t("{name} (draft: activate it before starting)", { name: a.name })}</option>
              ))}
            </select>
          </label>
          <label className="block"><span className="label">{t("Traffic in the experiment (%)")}</span><input name="traffic" type="number" min={1} max={100} className="input w-28" required defaultValue={v("traffic") || "100"} /></label>
        </div>
        <p className="text-xs text-ink-3">{t("People outside the traffic or the audience get no variant, so your app shows its default.")}</p>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="h2">{t("3. Goal")}</legend>
        <div className="flex flex-wrap items-end gap-3">
          <label className="block"><span className="label">{t("Goal event")}</span><input name="goalEvent" className="input w-64" dir="ltr" list="experiment-events" required maxLength={100} placeholder="order_completed" defaultValue={v("goalEvent")} /></label>
          <label className="block"><span className="label">{t("Within, after first exposure")}</span>
            <select name="goalWindow" className="input" defaultValue={v("goalWindow") || "7"}>
              {WINDOW_DAYS.map((d) => <option key={d} value={d}>{d === 1 ? t("1 day") : t("{n} days", { n: d })}</option>)}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="block"><span className="label">{t("Only when the property (optional)")}</span><input name="goalFilterName" className="input w-48" dir="ltr" maxLength={64} placeholder="payment_method" defaultValue={v("goalFilterName")} /></label>
          <label className="block"><span className="label">{t("Operator")}</span>
            <select name="goalFilterOp" className="input w-auto" value={filterOp} onChange={(e) => setFilterOp(e.target.value)}>
              {PROPERTY_OPS.map((op) => <option key={op} value={op}>{t(PROPERTY_OP_LABELS[op])}</option>)}
            </select>
          </label>
          {!noValue && <label className="block"><span className="label">{t("Value")}</span><input name="goalFilterValue" className="input w-48" maxLength={200} defaultValue={v("goalFilterValue")} /></label>}
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="h2">{t("4. Secondary metric (optional)")}</legend>
        <div className="flex flex-wrap gap-4 text-sm">
          {([["none", t("None")], ["event", t("Another event")], ["revenue", t("Revenue")]] as const).map(([k, label]) => (
            <label key={k} className="flex items-center gap-2"><input type="radio" name="secondaryKind" value={k} checked={secondary === k} onChange={() => setSecondary(k)} /> {label}</label>
          ))}
        </div>
        {secondary === "event" && <label className="block"><span className="label">{t("Secondary event")}</span><input name="secondaryEvent" className="input w-64" dir="ltr" list="experiment-events" required maxLength={100} defaultValue={v("secondaryEvent")} /></label>}
        {secondary === "revenue" && <p className="text-xs text-ink-3">{t("Net revenue per exposed person, per currency, by the rules on the Revenue page.")}</p>}
      </fieldset>
      <p className="text-xs text-ink-3">{t("The experiment is saved as a draft. Variants, traffic and the goal can't change after you start it.")}</p>
    </ActionForm>
  );
}
