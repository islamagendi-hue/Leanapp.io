"use client";

import { useId, useState } from "react";
import { FILTER_OPS } from "@/modules/properties/filters";

export interface FilterOption {
  name: string;
  type: string;
  description: string;
  values: string[];
}

export interface FilterParts {
  property: string;
  op: string;
  value: string;
}

/**
 * Property filter rows for a GET form: a property from the catalog, an
 * operator and a value with the property's observed values as suggestions.
 * Fields are named `<prefix>p`, `<prefix>o` and `<prefix>v`, repeated per row;
 * a row with no property is ignored. Shows the filters in use plus one empty
 * row while under `max`.
 */
export function PropertyFilters({ options, initial, max, prefix = "f", label = "Filter by property" }: {
  options: FilterOption[];
  initial: FilterParts[];
  max: number;
  prefix?: string;
  label?: string;
}) {
  const id = useId();
  const [rows, setRows] = useState<FilterParts[]>(() => {
    const start = initial.slice(0, max);
    return start.length < max ? [...start, { property: "", op: "eq", value: "" }] : start;
  });
  const known = new Set(options.map((o) => o.name));
  const set = (i: number, patch: Partial<FilterParts>) =>
    setRows((rs) => {
      const next = rs.map((r, j) => (j === i ? { ...r, ...patch } : r));
      const used = next.filter((r) => r.property);
      return used.length < max && next.every((r) => r.property) ? [...next, { property: "", op: "eq", value: "" }] : next;
    });

  return (
    <fieldset className="w-full space-y-2">
      <legend className="label">{label}</legend>
      {rows.map((r, i) => {
        const opt = options.find((o) => o.name === r.property);
        const noValue = r.op === "exists" || r.op === "not_exists";
        const listId = `${id}-v${i}`;
        return (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <select name={`${prefix}p`} className="input w-48" value={r.property} onChange={(e) => set(i, { property: e.target.value, value: "" })} aria-label={`Property ${i + 1}`}>
              <option value="">{i === 0 ? "Any property…" : "Add a filter…"}</option>
              {r.property && !known.has(r.property) && <option value={r.property}>{r.property}</option>}
              {options.map((o) => <option key={o.name} value={o.name} title={o.description || undefined}>{o.name}</option>)}
            </select>
            {r.property && (
              <>
                <select name={`${prefix}o`} className="input w-auto" value={r.op} onChange={(e) => set(i, { op: e.target.value })} aria-label={`Operator ${i + 1}`}>
                  {FILTER_OPS.map(([k, text]) => <option key={k} value={k}>{text}</option>)}
                </select>
                {noValue ? <input type="hidden" name={`${prefix}v`} value="" /> : (
                  <>
                    <input name={`${prefix}v`} className="input w-48" list={listId} value={r.value} onChange={(e) => set(i, { value: e.target.value })}
                      placeholder={r.op === "in" ? "a, b, c" : opt?.type === "number" ? "number" : "value"} maxLength={500} aria-label={`Value ${i + 1}`} />
                    <datalist id={listId}>{(opt?.values ?? []).map((v) => <option key={v} value={v} />)}</datalist>
                  </>
                )}
              </>
            )}
            {!r.property && <><input type="hidden" name={`${prefix}o`} value="" /><input type="hidden" name={`${prefix}v`} value="" /></>}
          </div>
        );
      })}
      {options.length === 0 && <p className="text-xs text-ink-3">No properties seen in this environment yet.</p>}
    </fieldset>
  );
}
