import type { CSSProperties } from "react";
import { getLang } from "@/i18n/server";
import { shortDay } from "@/modules/analytics/range";
import { ChartHover } from "./ChartHover";

/**
 * Server-rendered line chart for daily series. The SVG is drawn on the server
 * (complete and labelled without JavaScript, and under the CSP); ChartHover
 * adds the guide line and tooltip for the mouse, touch and arrow keys.
 *
 * The plot stretches to its container (lines keep a 2px stroke at any size),
 * while the axis labels are HTML text placed by percentage, so they stay at a
 * readable size on a phone instead of shrinking with the drawing.
 */
// Theme tokens: darker on light paper, brighter in dark mode (globals.css).
export const CHART_COLORS = [1, 2, 3, 4, 5, 6].map((n) => `var(--color-chart-${n})`);

const VW = 1000;
const VH = 100;

export async function TrendChart({ days, series, label }: { days: string[]; series: { key: string; counts: number[] }[]; label: string }) {
  const lang = await getLang();
  const max = Math.max(1, ...series.flatMap((s) => s.counts));
  const min = Math.min(0, ...series.flatMap((s) => s.counts)); // below zero only for net amounts (e.g. refunds)
  const step = Math.pow(10, Math.floor(Math.log10(Math.max(max, -min))));
  const top = Math.ceil(max / step) * step;
  const bottom = Math.floor(min / step) * step;
  // Positions as fractions of the plot: x from the start (left), y from the top.
  const fx = (i: number) => (days.length <= 1 ? 0.5 : i / (days.length - 1));
  const fy = (v: number) => 1 - (v - bottom) / (top - bottom);
  const ticks = bottom < 0 ? [bottom, 0, top] : [0, top / 2, top];
  const tickText = (v: number) => (Number.isInteger(v) ? v.toLocaleString("en-US") : v.toFixed(1));
  const gutter = Math.max(24, Math.max(...ticks.map((v) => tickText(v).length)) * 7 + 8);

  // About 8 dates on a wide chart and 4 on a phone; the last day is always labelled.
  const every = Math.max(1, Math.ceil(days.length / 8));
  let shown = days.map((_, i) => i).filter((i) => i % every === 0);
  const last = days.length - 1;
  if (last > 0 && !shown.includes(last)) {
    if (last - shown[shown.length - 1] < every * 0.6 && shown.length > 1) shown = shown.slice(0, -1);
    shown.push(last);
  }
  // On phones every other label, counted back from the last so it stays.
  const phone = new Set(shown.filter((_, k) => (shown.length - 1 - k) % 2 === 0));
  const color = (si: number) => CHART_COLORS[si % CHART_COLORS.length];

  return (
    <figure className="space-y-2">
      <div className="relative pb-6 pe-3 pt-2" style={{ direction: "ltr", paddingLeft: gutter }}>
        <div className="relative h-44 sm:h-56">
          {ticks.map((v) => (
            <span key={v} aria-hidden className="absolute -translate-y-1/2 pe-1.5 text-end text-[11px] leading-none tabular-nums text-ink-3 sm:text-xs" style={{ top: `${fy(v) * 100}%`, right: "100%" }}>
              {tickText(v)}
            </span>
          ))}
          {shown.map((i) => {
            const at = fx(i);
            const shift = days.length > 1 && i === 0 ? "0" : i === last && days.length > 1 ? "-100%" : "-50%";
            return (
              <span key={days[i]} aria-hidden className={`absolute top-full mt-1.5 whitespace-nowrap text-[11px] leading-none text-ink-3 sm:text-xs ${phone.has(i) ? "" : "max-sm:hidden"}`}
                style={{ left: `${at * 100}%`, transform: `translateX(${shift})` }}>
                {shortDay(days[i], lang)}
              </span>
            );
          })}
          <ChartHover xs={days.map((_, i) => fx(i))} days={days}
            series={series.map((s, si) => ({ key: s.key, color: color(si), values: s.counts, ys: s.counts.map(fy) }))}>
            <svg viewBox={`0 0 ${VW} ${VH}`} preserveAspectRatio="none" className="block h-full w-full overflow-visible" role="img" aria-label={label}>
              {ticks.map((v) => (
                <line key={v} x1={0} x2={VW} y1={fy(v) * VH} y2={fy(v) * VH} vectorEffect="non-scaling-stroke" strokeWidth="1"
                  style={{ stroke: v === 0 ? "var(--color-line-strong)" : "var(--color-line)" }} strokeDasharray={v ? "3 3" : undefined} />
              ))}
              {series.map((s, si) => (
                <polyline key={s.key} fill="none" vectorEffect="non-scaling-stroke" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"
                  style={{ stroke: color(si) }} points={s.counts.map((v, i) => `${fx(i) * VW},${fy(v) * VH}`).join(" ")} />
              ))}
            </svg>
            {/* Round dots (an SVG circle would stretch with the plot); each names its value without JavaScript. */}
            {days.length <= 31 && series.map((s, si) => s.counts.map((v, i) => (
              <span key={`${si}-${i}`} title={`${s.key} · ${shortDay(days[i], lang)}: ${v.toLocaleString("en-US")}`}
                className="absolute size-[5px] -translate-x-1/2 -translate-y-1/2 rounded-full"
                style={{ left: `${fx(i) * 100}%`, top: `${fy(v) * 100}%`, background: color(si) } as CSSProperties} />
            )))}
          </ChartHover>
        </div>
      </div>
      {series.length > 1 && (
        <figcaption className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
          {series.map((s, si) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span className="inline-block h-2 w-3 rounded-sm" style={{ background: color(si) }} />
              {s.key}
            </span>
          ))}
        </figcaption>
      )}
    </figure>
  );
}
