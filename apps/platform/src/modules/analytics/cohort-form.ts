/**
 * Cohort form fields ⇄ cohort input. The form works without JavaScript: an
 * empty event name means "no event condition", an empty user property name
 * means "no user property condition". Pure.
 */
import type { CohortDefinition, PropertyFilter } from "./sql";

type Get = (name: string) => string;

function filter(get: Get, prefix: string): Record<string, string> | undefined {
  const name = get(`${prefix}Name`).trim();
  if (!name) return undefined;
  return { name, op: get(`${prefix}Op`) || "eq", value: get(`${prefix}Value`) };
}

export function cohortInputFromForm(form: { get(name: string): FormDataEntryValue | null }) {
  const get: Get = (n) => {
    const v = form.get(n);
    return typeof v === "string" ? v : "";
  };
  const event = get("event").trim();
  const range = get("rangeKind") === "between"
    ? { kind: "between", from: get("from"), to: get("to") }
    : { kind: "last", days: get("lastDays") || "30" };
  return {
    name: get("name"),
    description: get("description"),
    definition: {
      event: event ? { name: event, minCount: get("minCount") || "1", range, property: filter(get, "ep") } : undefined,
      userProperty: filter(get, "up"),
    },
  };
}

/** Default field values for editing a definition. */
export function formDefaults(def?: CohortDefinition) {
  const f = (x?: PropertyFilter) => ({ name: x?.name ?? "", op: x?.op ?? "eq", value: x?.value ?? "" });
  const range = def?.event?.range;
  return {
    event: def?.event?.name ?? "",
    minCount: String(def?.event?.minCount ?? 1),
    rangeKind: range?.kind ?? "last",
    lastDays: String(range?.kind === "last" ? range.days : 30),
    from: range?.kind === "between" ? range.from : "",
    to: range?.kind === "between" ? range.to : "",
    ep: f(def?.event?.property),
    up: f(def?.userProperty),
  };
}

/** One-line, human description of a definition. */
export function describeCohort(def: CohortDefinition, opLabels: Record<string, string>): string {
  const prop = (x: PropertyFilter) => `${x.name} ${opLabels[x.op] ?? x.op}${x.op === "exists" || x.op === "not_exists" ? "" : ` ${x.value}`}`;
  const parts: string[] = [];
  if (def.event) {
    const e = def.event;
    const times = e.minCount > 1 ? ` at least ${e.minCount} times` : "";
    const when = e.range.kind === "last" ? `in the last ${e.range.days} day${e.range.days === 1 ? "" : "s"}` : `between ${e.range.from} and ${e.range.to}`;
    parts.push(`Did ${e.name}${times} ${when}${e.property ? ` where ${prop(e.property)}` : ""}`);
  }
  if (def.userProperty) parts.push(`${def.event ? "and" : "People whose"} user property ${prop(def.userProperty)}`);
  return parts.join(" ");
}
