import { getT } from "@/i18n/server";
import type { T } from "@/i18n/translate";
import { PROPERTY_OP_LABELS } from "@/modules/analytics/sql";
import type { EventRule, GrowthDefinition } from "@/modules/growth/definition";

function Rule({ rule, t }: { rule: EventRule | null; t: T }) {
  if (!rule) return <span className="text-ink-3">{t("not set")}</span>;
  return (
    <span>
      <span className="font-mono" dir="ltr">{rule.event}</span>
      {rule.filters.map((f) => (
        <span key={f.name} className="text-xs text-ink-3">{" "}{t("where {name} {op} {value}", { name: f.name, op: t(PROPERTY_OP_LABELS[f.op]), value: f.value })}</span>
      ))}
    </span>
  );
}

/** A growth definition in words. */
export async function DefinitionList({ def }: { def: GrowthDefinition }) {
  const t = await getT();
  return (
    <dl className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-1 text-sm">
      <dt className="text-ink-3">{t("Activation")}</dt><dd><Rule rule={def.activation} t={t} /></dd>
      <dt className="text-ink-3">{t("Core action")}</dt><dd><Rule rule={def.core_action} t={t} /></dd>
      <dt className="text-ink-3">{t("Revenue")}</dt>
      <dd>{def.revenue ? <span><span className="font-mono" dir="ltr">{def.revenue.event}</span> <span className="text-xs text-ink-3">{t("amount in {amount}, currency in {currency}", { amount: def.revenue.amount_property, currency: def.revenue.currency_property })}</span></span> : <span className="text-ink-3">{t("not set")}</span>}</dd>
      <dt className="text-ink-3">{t("Retention")}</dt><dd>{def.retention.return_event === "any" ? t("back on or after day 1, 7, 30 with any event") : t("back on or after day 1, 7, 30 with the core action")}</dd>
    </dl>
  );
}
