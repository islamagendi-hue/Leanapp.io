import type { EventLabels } from "@/modules/analytics/labels";

/** An event as people read it ("Order Completed"), with the name the SDK sends underneath for whoever implements it. */
export function EventName({ name, labels, technical = true }: { name: string; labels: EventLabels; technical?: boolean }) {
  const label = labels(name);
  return (
    <span className="inline-flex flex-col leading-tight" title={name}>
      <span>{label}</span>
      {technical && label !== name && <span className="font-mono text-[11px] text-ink-3">{name}</span>}
    </span>
  );
}
