import { PROPERTY_OP_LABELS } from "@/modules/analytics/sql";
import type { EventRule, GrowthDefinition } from "@/modules/growth/definition";

function Rule({ rule }: { rule: EventRule | null }) {
  if (!rule) return <span className="text-ink-3">not set</span>;
  return (
    <span>
      <span className="font-mono">{rule.event}</span>
      {rule.filters.map((f) => (
        <span key={f.name} className="text-xs text-ink-3"> where {f.name} {PROPERTY_OP_LABELS[f.op]} {f.value}</span>
      ))}
    </span>
  );
}

/** A growth definition in words. */
export function DefinitionList({ def }: { def: GrowthDefinition }) {
  return (
    <dl className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-1 text-sm">
      <dt className="text-ink-3">Activation</dt><dd><Rule rule={def.activation} /></dd>
      <dt className="text-ink-3">Core action</dt><dd><Rule rule={def.core_action} /></dd>
      <dt className="text-ink-3">Revenue</dt>
      <dd>{def.revenue ? <span><span className="font-mono">{def.revenue.event}</span> <span className="text-xs text-ink-3">amount in {def.revenue.amount_property}, currency in {def.revenue.currency_property}</span></span> : <span className="text-ink-3">not set</span>}</dd>
      <dt className="text-ink-3">Retention</dt><dd>back on or after day 1, 7, 30 with {def.retention.return_event === "any" ? "any event" : "the core action"}</dd>
    </dl>
  );
}

