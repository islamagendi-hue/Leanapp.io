import { CHART_COLORS } from "@/components/TrendChart";

const share = (x: number) => `${Math.round(x * 100)}%`;

/**
 * The Overview's conversion funnel as columns: each step's share of the
 * people who did the first step, its name under it and the people count on
 * hover. Same numbers as Analytics → Funnels.
 */
export function FunnelBars({ steps, label }: { steps: { name: string; label: string; people: number; fromStart: number }[]; label: string }) {
  return (
    <figure aria-label={label}>
      <div className="grid h-40 items-end gap-2 sm:h-48 sm:gap-3" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
        {steps.map((s, i) => (
          <div key={s.name} className="flex h-full flex-col justify-end" title={`${s.label}: ${s.people.toLocaleString("en-US")}`}>
            <span className="mb-1.5 text-center text-sm font-medium tabular-nums text-ink-2">{share(s.fromStart)}</span>
            <span className="block min-h-1 rounded-t-lg bg-chart-1" style={{ height: `${Math.max(2, s.fromStart * 85)}%`, opacity: 1 - i * 0.15 }} />
          </div>
        ))}
      </div>
      <div className="mt-2 grid gap-2 sm:gap-3" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
        {steps.map((s) => (
          <figcaption key={s.name} className="min-w-0 text-center text-xs text-ink-3 sm:text-sm">
            <span className="block truncate">{s.label}</span>
            <span className="block tabular-nums">{s.people.toLocaleString("en-US")}</span>
          </figcaption>
        ))}
      </div>
    </figure>
  );
}

/** Installs by channel as bars of their share, largest first. */
export function SourceBars({ rows, label }: { rows: { key: string; label: string; installs: number; share: number }[]; label: string }) {
  const max = Math.max(...rows.map((r) => r.share), 0.0001);
  return (
    <ul className="space-y-3" aria-label={label}>
      {rows.map((r, i) => (
        <li key={r.key} className="grid grid-cols-[minmax(0,7rem)_1fr_3rem] items-center gap-3 text-sm" title={`${r.label}: ${r.installs.toLocaleString("en-US")}`}>
          <span className="truncate text-ink-2">{r.label}</span>
          <span className="h-2.5 overflow-hidden rounded-full bg-paper-2">
            <span className="block h-full rounded-full" style={{ width: `${(r.share / max) * 100}%`, background: CHART_COLORS[i % CHART_COLORS.length] }} />
          </span>
          <span className="text-end font-medium tabular-nums text-ink-2">{share(r.share)}</span>
        </li>
      ))}
    </ul>
  );
}
