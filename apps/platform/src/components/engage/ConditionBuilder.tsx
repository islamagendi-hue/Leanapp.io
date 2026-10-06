"use client";

import { useId, useState } from "react";

/**
 * Editor for an audience condition tree. Works on the same JSON the server
 * validates (modules/audiences/definition.ts); NOT is shown as an "Exclude"
 * toggle on any condition or group. The server is the authority: this only
 * builds the JSON.
 */
export type Json = Record<string, unknown>;
type Node = Json & { type: string };

const PROPERTY_OPS: [string, string][] = [
  ["eq", "is"], ["neq", "is not"], ["gt", ">"], ["gte", "≥"], ["lt", "<"], ["lte", "≤"],
  ["contains", "contains"], ["not_contains", "doesn't contain"], ["in", "is one of"], ["exists", "is set"], ["not_exists", "is not set"],
];
const PLATFORMS = ["android", "ios", "web", "react_native", "flutter", "backend"];
const KINDS: [string, string][] = [
  ["event", "Did / didn't do an event"],
  ["user_property", "User property"],
  ["first_seen", "First seen"],
  ["last_seen", "Last seen"],
  ["platform", "Platform"],
  ["revenue", "Revenue total"],
];

export function defaultLeaf(type: string): Node {
  switch (type) {
    case "event": return { type, event: "", did: true, countOp: "gte", count: 1, withinDays: 30, where: [] };
    case "user_property": return { type, property: "", op: "eq", value: "" };
    case "first_seen":
    case "last_seen": return { type, op: "within_days", days: 7 };
    case "platform": return { type, platforms: ["ios"] };
    default: return { type: "revenue", op: "gte", amount: 100, withinDays: 90, events: [], property: "revenue" };
  }
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

export function ConditionBuilder({ value, onChange, events, allowSinceTrigger = false }: { value: Node; onChange: (n: Node) => void; events: string[]; allowSinceTrigger?: boolean }) {
  const listId = useId();
  return (
    <div>
      <datalist id={listId}>{events.map((e) => <option key={e} value={e} />)}</datalist>
      <NodeEditor node={value} onChange={onChange} listId={listId} allowSinceTrigger={allowSinceTrigger} depth={0} />
    </div>
  );
}

function NodeEditor({ node, onChange, onRemove, listId, allowSinceTrigger, depth }: {
  node: Node; onChange: (n: Node) => void; onRemove?: () => void; listId: string; allowSinceTrigger: boolean; depth: number;
}) {
  const negated = node.type === "not";
  const inner = (negated ? (node.child as Node) : node);
  const set = (n: Node) => onChange(negated ? { type: "not", child: n } : n);
  const toggleNot = () => onChange(negated ? inner : { type: "not", child: node });
  const header = (
    <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
      <label className="inline-flex items-center gap-1"><input type="checkbox" checked={negated} onChange={toggleNot} /> Exclude people matching this</label>
      {onRemove && <button type="button" className="ms-auto text-alert hover:underline" onClick={onRemove}>Remove</button>}
    </div>
  );

  if (inner.type === "and" || inner.type === "or") {
    const children = (inner.children as Node[]) ?? [];
    const setChild = (i: number, c: Node) => set({ ...inner, children: children.map((x, j) => (j === i ? c : x)) });
    return (
      <div className={`space-y-3 rounded-lg border p-3 ${negated ? "border-alert/40 bg-alert-soft/30" : "border-line"} ${depth ? "bg-paper/40" : ""}`}>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>People who match</span>
          <select className="input w-auto" value={inner.type} onChange={(e) => set({ ...inner, type: e.target.value })}>
            <option value="and">all</option>
            <option value="or">any</option>
          </select>
          <span>of these conditions</span>
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
            <option value="">+ Add condition…</option>
            {KINDS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
          {depth < 3 && (
            <button type="button" className="btn-secondary min-h-9 text-sm" onClick={() => set({ ...inner, children: [...children, { type: inner.type === "and" ? "or" : "and", children: [defaultLeaf("event")] }] })}>
              + Add group
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
          {KINDS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
      </div>
      <LeafEditor leaf={inner} onChange={set} listId={listId} allowSinceTrigger={allowSinceTrigger} />
      {header}
    </div>
  );
}

function FilterRow({ f, onChange, onRemove, prefix }: { f: Json; onChange: (f: Json) => void; onRemove?: () => void; prefix?: string }) {
  const op = String(f.op ?? "eq");
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      {prefix && <span className="text-ink-3">{prefix}</span>}
      <input className="input w-40" placeholder="property" value={String(f.property ?? "")} onChange={(e) => onChange({ ...f, property: e.target.value })} aria-label="Property" />
      <select className="input w-auto" value={op} onChange={(e) => onChange({ ...f, op: e.target.value, value: parseValue(e.target.value, valueText(f.value)) })} aria-label="Operator">
        {PROPERTY_OPS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
      </select>
      {op !== "exists" && op !== "not_exists" && (
        <ParsedInput key={op} className="input w-44" placeholder={op === "in" ? "a, b, c" : "value"} value={f.value} parse={(raw) => parseValue(op, raw)} onChange={(v) => onChange({ ...f, value: v })} aria-label="Value" />
      )}
      {onRemove && <button type="button" className="text-xs text-alert hover:underline" onClick={onRemove}>remove</button>}
    </div>
  );
}

function LeafEditor({ leaf, onChange, listId, allowSinceTrigger }: { leaf: Node; onChange: (n: Node) => void; listId: string; allowSinceTrigger: boolean }) {
  const num = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => onChange({ ...leaf, [k]: e.target.value === "" ? "" : Number(e.target.value) });
  switch (leaf.type) {
    case "event": {
      const where = (leaf.where as Json[]) ?? [];
      return (
        <div className="space-y-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <select className="input w-auto" value={leaf.did === false ? "no" : "yes"} onChange={(e) => onChange({ ...leaf, did: e.target.value === "yes" })}>
              <option value="yes">did</option>
              <option value="no">did not do</option>
            </select>
            <input className="input w-56" list={listId} placeholder="event name" value={String(leaf.event ?? "")} onChange={(e) => onChange({ ...leaf, event: e.target.value })} aria-label="Event" />
            {leaf.did !== false && (
              <>
                <select className="input w-auto" value={String(leaf.countOp ?? "gte")} onChange={(e) => onChange({ ...leaf, countOp: e.target.value })} aria-label="Count">
                  <option value="gte">at least</option>
                  <option value="eq">exactly</option>
                  <option value="lte">at most</option>
                </select>
                <input className="input w-20" type="number" min={1} value={String(leaf.count ?? 1)} onChange={num("count")} aria-label="Times" />
                <span>times</span>
              </>
            )}
            {leaf.sinceTrigger ? <span>since the trigger</span> : (
              <>
                <span>in the last</span>
                <input className="input w-20" type="number" min={1} max={365} value={String(leaf.withinDays ?? 30)} onChange={num("withinDays")} aria-label="Days" />
                <span>days</span>
              </>
            )}
          </div>
          {allowSinceTrigger && (
            <label className="inline-flex items-center gap-1 text-xs text-ink-2">
              <input type="checkbox" checked={Boolean(leaf.sinceTrigger)} onChange={(e) => onChange({ ...leaf, sinceTrigger: e.target.checked || undefined })} /> Count only since the automation was triggered
            </label>
          )}
          {where.map((f, i) => (
            <FilterRow key={i} f={f} prefix={i === 0 ? "where" : "and"} onChange={(nf) => onChange({ ...leaf, where: where.map((x, j) => (j === i ? nf : x)) })} onRemove={() => onChange({ ...leaf, where: where.filter((_, j) => j !== i) })} />
          ))}
          {where.length < 5 && (
            <button type="button" className="text-xs text-accent-ink hover:underline" onClick={() => onChange({ ...leaf, where: [...where, { property: "", op: "eq", value: "" }] })}>+ event property filter</button>
          )}
        </div>
      );
    }
    case "user_property":
      return <FilterRow f={leaf} onChange={(f) => onChange({ ...(f as Node), type: "user_property" })} />;
    case "first_seen":
    case "last_seen":
      return (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <select className="input w-auto" value={String(leaf.op)} onChange={(e) => onChange({ ...leaf, op: e.target.value })}>
            <option value="within_days">in the last</option>
            <option value="before_days">more than</option>
          </select>
          <input className="input w-20" type="number" min={1} max={365} value={String(leaf.days ?? 7)} onChange={num("days")} aria-label="Days" />
          <span>days{leaf.op === "before_days" ? " ago" : ""}</span>
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
    default:
      return (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>sum of</span>
          <input className="input w-28" value={String(leaf.property ?? "revenue")} onChange={(e) => onChange({ ...leaf, property: e.target.value })} aria-label="Revenue property" />
          <select className="input w-auto" value={String(leaf.op)} onChange={(e) => onChange({ ...leaf, op: e.target.value })} aria-label="Comparison">
            {[["gte", "≥"], ["gt", ">"], ["lte", "≤"], ["lt", "<"], ["eq", "="]].map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <input className="input w-28" type="number" min={0} value={String(leaf.amount ?? 0)} onChange={num("amount")} aria-label="Amount" />
          <span>in the last</span>
          <input className="input w-20" type="number" min={1} max={365} value={String(leaf.withinDays ?? 90)} onChange={num("withinDays")} aria-label="Days" />
          <span>days, from</span>
          <ParsedInput className="input w-56" placeholder="any event (or: purchase, renewal)" value={leaf.events ?? []} parse={commaList}
            onChange={(v) => onChange({ ...leaf, events: v })} aria-label="Events" />
        </div>
      );
  }
}
