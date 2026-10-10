"use client";

import { createContext, useContext, useId, useState } from "react";
import { useT } from "@/i18n/client";
import { msg } from "@/i18n/translate";
import { RFM_SEGMENTS, RFM_WINDOWS, SEGMENT_LABELS } from "@/modules/analytics/rfm-pure";

/**
 * Editor for an audience condition tree. Works on the same JSON the server
 * validates (modules/audiences/definition.ts); NOT is shown as an "Exclude"
 * toggle on any condition or group. The server is the authority: this only
 * builds the JSON.
 */
export type Json = Record<string, unknown>;
type Node = Json & { type: string };

/** Property names and observed values from the project's property catalog (suggestions only). */
export interface PropertyLists {
  user: { name: string; values: string[] }[];
  event: { name: string; values: string[] }[];
}
const Catalog = createContext<{ id: string; lists: PropertyLists }>({ id: "", lists: { user: [], event: [] } });

/** Datalist ids for a property name and for its values (undefined when the catalog doesn't know it). */
function useLists(scope: "user" | "event", name: string) {
  const { id, lists } = useContext(Catalog);
  const i = lists[scope].findIndex((o) => o.name === name);
  return { names: `${id}-${scope}`, values: i >= 0 ? `${id}-${scope}-${i}` : undefined };
}

const PROPERTY_OPS: [string, string][] = [
  ["eq", msg("is")], ["neq", msg("is not")], ["gt", ">"], ["gte", "≥"], ["lt", "<"], ["lte", "≤"],
  ["contains", msg("contains")], ["not_contains", msg("doesn't contain")], ["in", msg("is one of")], ["exists", msg("is set")], ["not_exists", msg("is not set")],
];
const PLATFORMS = ["android", "ios", "web", "react_native", "flutter", "backend"];
const KINDS: [string, string][] = [
  ["event", msg("Did / didn't do an event")],
  ["user_property", msg("User property")],
  ["first_seen", msg("First seen")],
  ["last_seen", msg("Last seen")],
  ["platform", msg("Platform")],
  ["revenue", msg("Revenue total")],
  ["rfm", msg("RFM segment")],
];

export function defaultLeaf(type: string): Node {
  switch (type) {
    case "event": return { type, event: "", did: true, countOp: "gte", count: 1, withinDays: 30, where: [] };
    case "user_property": return { type, property: "", op: "eq", value: "" };
    case "first_seen":
    case "last_seen": return { type, op: "within_days", days: 7 };
    case "platform": return { type, platforms: ["ios"] };
    case "rfm": return { type, segments: ["champions"], withinDays: 365, currency: "" };
    default: return { type: "revenue", op: "gte", amount: 100, withinDays: 90, events: [], property: "revenue" };
  }
}

/** A YYYY-MM-DD date `n` days before today (the browser's calendar; the server reads it in the project's timezone). */
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Typed value from a text box: numbers and booleans become JSON numbers and booleans; "in" takes a comma list. */
export function parseValue(op: string, raw: string): unknown {
  if (op === "exists" || op === "not_exists") return undefined;
  if (op === "in") return raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (["gt", "gte", "lt", "lte"].includes(op)) return raw === "" ? "" : Number(raw);
  if (/^-?\d+(\.\d+)?$/.test(raw.trim())) return Number(raw);
  if (raw === "true" || raw === "false") return raw === "true";
  return raw;
}
export const valueText = (v: unknown) => (Array.isArray(v) ? v.join(", ") : v === undefined || v === null ? "" : String(v));

/** A text box that keeps what the person typed and reports a parsed value (so "1." or "a, " can be typed). */
export function ParsedInput({ value, parse, onChange, ...rest }: { value: unknown; parse: (raw: string) => unknown; onChange: (v: unknown) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  const [text, setText] = useState(valueText(value));
  return <input {...rest} value={text} onChange={(e) => { setText(e.target.value); onChange(parse(e.target.value)); }} />;
}

const commaList = (raw: string) => raw.split(",").map((s) => s.trim()).filter(Boolean);

export function ConditionBuilder({ value, onChange, events, properties, allowSinceTrigger = false }: {
  value: Node; onChange: (n: Node) => void; events: string[]; properties?: PropertyLists; allowSinceTrigger?: boolean;
}) {
  const listId = useId();
  const lists = properties ?? { user: [], event: [] };
  return (
    <Catalog.Provider value={{ id: listId, lists }}>
      <datalist id={listId}>{events.map((e) => <option key={e} value={e} />)}</datalist>
      {(["user", "event"] as const).map((scope) => (
        <div key={scope} hidden>
          <datalist id={`${listId}-${scope}`}>{lists[scope].map((o) => <option key={o.name} value={o.name} />)}</datalist>
          {lists[scope].map((o, i) => <datalist key={o.name} id={`${listId}-${scope}-${i}`}>{o.values.map((v) => <option key={v} value={v} />)}</datalist>)}
        </div>
      ))}
      <NodeEditor node={value} onChange={onChange} listId={listId} allowSinceTrigger={allowSinceTrigger} depth={0} />
    </Catalog.Provider>
  );
}

function NodeEditor({ node, onChange, onRemove, listId, allowSinceTrigger, depth }: {
  node: Node; onChange: (n: Node) => void; onRemove?: () => void; listId: string; allowSinceTrigger: boolean; depth: number;
}) {
  const t = useT();
  const negated = node.type === "not";
  const inner = (negated ? (node.child as Node) : node);
  const set = (n: Node) => onChange(negated ? { type: "not", child: n } : n);
  const toggleNot = () => onChange(negated ? inner : { type: "not", child: node });
  const header = (
    <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
      <label className="inline-flex items-center gap-1"><input type="checkbox" checked={negated} onChange={toggleNot} /> {t("Exclude people matching this")}</label>
      {onRemove && <button type="button" className="ms-auto text-alert hover:underline" onClick={onRemove}>{t("Remove")}</button>}
    </div>
  );

  if (inner.type === "and" || inner.type === "or") {
    const children = (inner.children as Node[]) ?? [];
    const setChild = (i: number, c: Node) => set({ ...inner, children: children.map((x, j) => (j === i ? c : x)) });
    return (
      <div className={`space-y-3 rounded-lg border p-3 ${negated ? "border-alert/40 bg-alert-soft/30" : "border-line"} ${depth ? "bg-paper/40" : ""}`}>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>{t("People who match")}</span>
          <select className="input w-auto" value={inner.type} onChange={(e) => set({ ...inner, type: e.target.value })}>
            <option value="and">{t("all")}</option>
            <option value="or">{t("any")}</option>
          </select>
          <span>{t("of these conditions")}</span>
        </div>
        {header}
        <ul className="space-y-3">
          {children.map((c, i) => (
            <li key={i}>
              <NodeEditor node={c} listId={listId} allowSinceTrigger={allowSinceTrigger} depth={depth + 1}
                onChange={(n) => setChild(i, n)}
                onRemove={children.length > 1 ? () => set({ ...inner, children: children.filter((_, j) => j !== i) }) : undefined} />
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <select className="input w-auto text-sm" value="" onChange={(e) => e.target.value && set({ ...inner, children: [...children, defaultLeaf(e.target.value)] })}>
            <option value="">{t("+ Add condition…")}</option>
            {KINDS.map(([k, label]) => <option key={k} value={k}>{t(label)}</option>)}
          </select>
          {depth < 3 && (
            <button type="button" className="btn-secondary min-h-9 text-sm" onClick={() => set({ ...inner, children: [...children, { type: inner.type === "and" ? "or" : "and", children: [defaultLeaf("event")] }] })}>
              {t("+ Add group")}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={`space-y-2 rounded-lg border p-3 ${negated ? "border-alert/40 bg-alert-soft/30" : "border-line bg-card"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <select className="input w-auto text-sm" value={inner.type} onChange={(e) => set(defaultLeaf(e.target.value))}>
          {KINDS.map(([k, label]) => <option key={k} value={k}>{t(label)}</option>)}
        </select>
      </div>
      <LeafEditor leaf={inner} onChange={set} listId={listId} allowSinceTrigger={allowSinceTrigger} />
      {header}
    </div>
  );
}

function FilterRow({ f, scope, onChange, onRemove, prefix }: { f: Json; scope: "user" | "event"; onChange: (f: Json) => void; onRemove?: () => void; prefix?: string }) {
  const op = String(f.op ?? "eq");
  const lists = useLists(scope, String(f.property ?? ""));
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      {prefix && <span className="text-ink-3">{prefix}</span>}
      <input className="input w-40" list={lists.names} placeholder={t("property")} value={String(f.property ?? "")} onChange={(e) => onChange({ ...f, property: e.target.value })} aria-label={t("Property")} dir="ltr" />
      <select className="input w-auto" value={op} onChange={(e) => onChange({ ...f, op: e.target.value, value: parseValue(e.target.value, valueText(f.value)) })} aria-label={t("Operator")}>
        {PROPERTY_OPS.map(([k, label]) => <option key={k} value={k}>{t(label)}</option>)}
      </select>
      {op !== "exists" && op !== "not_exists" && (
        <ParsedInput key={op} className="input w-44" list={lists.values} placeholder={op === "in" ? "a, b, c" : t("value")} value={f.value} parse={(raw) => parseValue(op, raw)} onChange={(v) => onChange({ ...f, value: v })} aria-label={t("Value")} />
      )}
      {onRemove && <button type="button" className="text-xs text-alert hover:underline" onClick={onRemove}>{t("remove")}</button>}
    </div>
  );
}

function LeafEditor({ leaf, onChange, listId, allowSinceTrigger }: { leaf: Node; onChange: (n: Node) => void; listId: string; allowSinceTrigger: boolean }) {
  const num = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => onChange({ ...leaf, [k]: e.target.value === "" ? "" : Number(e.target.value) });
  const t = useT();
  switch (leaf.type) {
    case "event": {
      const where = (leaf.where as Json[]) ?? [];
      return (
        <div className="space-y-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <select className="input w-auto" value={leaf.did === false ? "no" : "yes"} onChange={(e) => onChange({ ...leaf, did: e.target.value === "yes" })}>
              <option value="yes">{t("did")}</option>
              <option value="no">{t("did not do")}</option>
            </select>
            <input className="input w-56" list={listId} placeholder={t("event name")} value={String(leaf.event ?? "")} onChange={(e) => onChange({ ...leaf, event: e.target.value })} aria-label={t("Event")} dir="ltr" />
            {leaf.did !== false && (
              <>
                <select className="input w-auto" value={String(leaf.countOp ?? "gte")} onChange={(e) => onChange({ ...leaf, countOp: e.target.value })} aria-label={t("Count")}>
                  <option value="gte">{t("at least")}</option>
                  <option value="eq">{t("exactly")}</option>
                  <option value="lte">{t("at most")}</option>
                </select>
                <input className="input w-20" type="number" min={1} value={String(leaf.count ?? 1)} onChange={num("count")} aria-label={t("Times")} />
                <span>{t("times")}</span>
              </>
            )}
            {leaf.sinceTrigger ? <span>{t("since the trigger")}</span> : (
              <>
                <select className="input w-auto" value={leaf.between ? "between" : "last"} aria-label={t("When")}
                  onChange={(e) => {
                    onChange(e.target.value === "between" ? { ...leaf, between: { from: daysAgo(Number(leaf.withinDays) || 30), to: daysAgo(0) } } : { ...leaf, between: undefined });
                  }}>
                  <option value="last">{t("in the last")}</option>
                  <option value="between">{t("between")}</option>
                </select>
                {leaf.between ? (
                  <>
                    <input className="input w-40" type="date" value={String((leaf.between as Json).from ?? "")} onChange={(e) => onChange({ ...leaf, between: { ...(leaf.between as Json), from: e.target.value } })} aria-label={t("From")} />
                    <span>{t("and")}</span>
                    <input className="input w-40" type="date" value={String((leaf.between as Json).to ?? "")} onChange={(e) => onChange({ ...leaf, between: { ...(leaf.between as Json), to: e.target.value } })} aria-label={t("To")} />
                  </>
                ) : (
                  <>
                    <input className="input w-20" type="number" min={1} max={365} value={String(leaf.withinDays ?? 30)} onChange={num("withinDays")} aria-label={t("Days")} />
                    <span>{t("days")}</span>
                  </>
                )}
              </>
            )}
          </div>
          {allowSinceTrigger && (
            <label className="inline-flex items-center gap-1 text-xs text-ink-2">
              <input type="checkbox" checked={Boolean(leaf.sinceTrigger)} onChange={(e) => onChange({ ...leaf, sinceTrigger: e.target.checked || undefined, ...(e.target.checked ? { between: undefined } : {}) })} /> {t("Count only since the automation was triggered")}
            </label>
          )}
          {where.map((f, i) => (
            <FilterRow key={i} f={f} scope="event" prefix={i === 0 ? t("where") : t("and")} onChange={(nf) => onChange({ ...leaf, where: where.map((x, j) => (j === i ? nf : x)) })} onRemove={() => onChange({ ...leaf, where: where.filter((_, j) => j !== i) })} />
          ))}
          {where.length < 5 && (
            <button type="button" className="text-xs text-accent-ink hover:underline" onClick={() => onChange({ ...leaf, where: [...where, { property: "", op: "eq", value: "" }] })}>{t("+ event property filter")}</button>
          )}
        </div>
      );
    }
    case "user_property":
      return <FilterRow f={leaf} scope="user" onChange={(f) => onChange({ ...(f as Node), type: "user_property" })} />;
    case "first_seen":
    case "last_seen":
      return (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <select className="input w-auto" value={String(leaf.op)} onChange={(e) => onChange({ ...leaf, op: e.target.value })}>
            <option value="within_days">{t("in the last")}</option>
            <option value="before_days">{t("more than")}</option>
          </select>
          <input className="input w-20" type="number" min={1} max={365} value={String(leaf.days ?? 7)} onChange={num("days")} aria-label={t("Days")} />
          <span>{leaf.op === "before_days" ? t("days ago") : t("days")}</span>
        </div>
      );
    case "platform": {
      const chosen = new Set((leaf.platforms as string[]) ?? []);
      return (
        <div className="flex flex-wrap gap-3 text-sm">
          {PLATFORMS.map((p) => (
            <label key={p} className="inline-flex items-center gap-1">
              <input type="checkbox" checked={chosen.has(p)} onChange={(e) => {
                const next = new Set(chosen);
                if (e.target.checked) next.add(p);
                else next.delete(p);
                onChange({ ...leaf, platforms: PLATFORMS.filter((x) => next.has(x)) });
              }} /> {p}
            </label>
          ))}
        </div>
      );
    }
    case "rfm": {
      const chosen = new Set((leaf.segments as string[]) ?? []);
      const windowDays = Number(leaf.withinDays ?? 365);
      return (
        <div className="space-y-2 text-sm">
          <div className="flex flex-wrap gap-3">
            {RFM_SEGMENTS.map((s) => (
              <label key={s} className="inline-flex items-center gap-1">
                <input type="checkbox" checked={chosen.has(s)} onChange={(e) => {
                  const next = new Set(chosen);
                  if (e.target.checked) next.add(s);
                  else next.delete(s);
                  onChange({ ...leaf, segments: RFM_SEGMENTS.filter((x) => next.has(x)) });
                }} /> {t(SEGMENT_LABELS[s])}
              </label>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span>{t("purchases in")}</span>
            <input className="input w-20" dir="ltr" placeholder="SAR" value={String(leaf.currency ?? "")} onChange={(e) => onChange({ ...leaf, currency: e.target.value.toUpperCase() })} aria-label={t("Currency")} />
            <span>{t("in the last")}</span>
            <select className="input w-auto" value={String(windowDays)} onChange={(e) => onChange({ ...leaf, withinDays: Number(e.target.value) })} aria-label={t("Days")}>
              {[...new Set([...RFM_WINDOWS, windowDays])].sort((a, b) => a - b).map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            <span>{t("days")}</span>
          </div>
        </div>
      );
    }
    default:
      return <RevenueLeaf leaf={leaf} onChange={onChange} num={num} />;
  }
}

function RevenueLeaf({ leaf, onChange, num }: { leaf: Node; onChange: (n: Node) => void; num: (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => void }) {
  const lists = useLists("event", String(leaf.property ?? "revenue"));
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span>{t("sum of")}</span>
      <input className="input w-28" list={lists.names} value={String(leaf.property ?? "revenue")} onChange={(e) => onChange({ ...leaf, property: e.target.value })} aria-label={t("Revenue property")} dir="ltr" />
      <select className="input w-auto" value={String(leaf.op)} onChange={(e) => onChange({ ...leaf, op: e.target.value })} aria-label={t("Comparison")}>
        {[["gte", "≥"], ["gt", ">"], ["lte", "≤"], ["lt", "<"], ["eq", "="]].map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </select>
      <input className="input w-28" type="number" min={0} value={String(leaf.amount ?? 0)} onChange={num("amount")} aria-label={t("Amount")} />
      <span>{t("in the last")}</span>
      <input className="input w-20" type="number" min={1} max={365} value={String(leaf.withinDays ?? 90)} onChange={num("withinDays")} aria-label={t("Days")} />
      <span>{t("days, from")}</span>
      <ParsedInput className="input w-56" placeholder={t("any event (or: purchase, renewal)")} value={leaf.events ?? []} parse={commaList}
        onChange={(v) => onChange({ ...leaf, events: v })} aria-label={t("Events")} />
    </div>
  );
}
