/**
 * Property filters as people pick them in forms (a property, an operator and
 * the value as typed), turned into the audience filter shape that every
 * surface compiles with the same SQL (audiences/definition propertyPredicate).
 * Pure.
 */
import { NUMERIC_OPS, propertyFilterSchema, type PropertyFilter, type PropertyOp } from "@/modules/audiences/definition";

/** Operators offered in filter forms, in display order. */
export const FILTER_OPS: [PropertyOp, string][] = [
  ["eq", "is"],
  ["neq", "is not"],
  ["contains", "contains"],
  ["not_contains", "does not contain"],
  ["in", "is one of"],
  ["gt", ">"],
  ["gte", "≥"],
  ["lt", "<"],
  ["lte", "≤"],
  ["exists", "is set"],
  ["not_exists", "is not set"],
];

/** A filter from form parts, or null when the property is empty or the filter isn't valid. */
export function filterFromParts(property: string | undefined, op: string | undefined, raw: string | undefined): PropertyFilter | null {
  const name = property?.trim();
  if (!name) return null;
  const o = (FILTER_OPS.find(([k]) => k === op)?.[0] ?? "eq") as PropertyOp;
  const text = (raw ?? "").trim();
  let value: unknown;
  if (o === "exists" || o === "not_exists") value = undefined;
  else if (NUMERIC_OPS.includes(o)) value = text === "" ? undefined : Number(text);
  else if (o === "in") value = text.split(",").map((s) => s.trim()).filter(Boolean);
  else value = text;
  const r = propertyFilterSchema.safeParse({ property: name, op: o, value });
  return r.success ? r.data : null;
}

/** Form parts for a filter (the inverse of filterFromParts). */
export function partsFromFilter(f: PropertyFilter): { property: string; op: string; value: string } {
  const v = f.value;
  return { property: f.property, op: f.op, value: Array.isArray(v) ? v.join(", ") : v === undefined ? "" : String(v) };
}

type Search = Record<string, string | string[] | undefined>;
const all = (v: string | string[] | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/**
 * Filters from a query string written by the PropertyFilters form (`<prefix>p`,
 * `<prefix>o`, `<prefix>v`, repeated per row). Rows without a property, and
 * rows that aren't valid filters, are dropped; `parts` keeps what the person
 * typed (valid or not) so the form shows it again.
 */
export function filtersFromSearch(sp: Search, prefix: string, max: number): { filters: PropertyFilter[]; parts: { property: string; op: string; value: string }[] } {
  const ps = all(sp[`${prefix}p`]);
  const os = all(sp[`${prefix}o`]);
  const vs = all(sp[`${prefix}v`]);
  const parts = ps
    .map((property, i) => ({ property: property.trim(), op: os[i] || "eq", value: vs[i] ?? "" }))
    .filter((x) => x.property)
    .slice(0, max);
  const filters = parts.map((x) => filterFromParts(x.property, x.op, x.value)).filter((f): f is PropertyFilter => f !== null);
  return { filters, parts };
}
