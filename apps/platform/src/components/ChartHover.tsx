"use client";

import { useEffect, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { useLang } from "@/i18n/client";
import { dateLocale, type Lang } from "@/i18n/translate";

export type HoverSeries = { key: string; color: string; values: number[]; ys: number[] };

const value = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 2 });

/**
 * The interactive layer over a server-rendered TrendChart: pointing at the
 * chart (mouse, pen or a finger dragged across it) or using the arrow keys
 * shows a guide line, the points of that day and a tooltip with the date and
 * each series' value. The chart itself stays the server's SVG, so without
 * JavaScript it is still drawn and labelled; this only adds to it.
 */
export function ChartHover({ width, height, top, bottom, xs, days, series, children }: {
  width: number; height: number; top: number; bottom: number; xs: number[]; days: string[]; series: HoverSeries[]; children: ReactNode;
}) {
  const lang = useLang();
  const [i, setI] = useState<number | null>(null);
  const [ready, setReady] = useState(false);
  // Focusable only once this layer runs: without JavaScript there is nothing to move through.
  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);
  if (days.length === 0) return <>{children}</>;

  const nearest = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * width;
    let best = 0;
    for (let k = 1; k < xs.length; k++) if (Math.abs(xs[k] - x) < Math.abs(xs[best] - x)) best = k;
    setI(best);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    // The chart always runs left to right (oldest first), in Arabic too.
    const last = days.length - 1;
    const next = e.key === "ArrowRight" ? Math.min(last, (i ?? -1) + 1)
      : e.key === "ArrowLeft" ? Math.max(0, (i ?? last + 1) - 1)
      : e.key === "Home" ? 0 : e.key === "End" ? last : e.key === "Escape" ? null : undefined;
    if (next === undefined) return;
    e.preventDefault();
    setI(next);
  };

  const shown = i;
  const at = shown === null ? 0 : xs[shown] / width;
  const date = shown === null ? "" : formatDay(days[shown], lang);
  return (
    <div
      className="relative touch-pan-y select-none outline-offset-4"
      data-chart-hover=""
      tabIndex={ready ? 0 : undefined}
      onPointerMove={nearest}
      onPointerDown={nearest}
      onPointerLeave={(e) => { if (e.pointerType === "mouse") setI(null); }}
      onKeyDown={onKey}
      onBlur={() => setI(null)}
    >
      {children}
      {shown !== null && (
        <>
          <svg viewBox={`0 0 ${width} ${height}`} className="pointer-events-none absolute inset-0 h-full w-full" style={{ direction: "ltr" }} aria-hidden="true">
            <line x1={xs[shown]} x2={xs[shown]} y1={top} y2={height - bottom} className="stroke-line-strong" strokeWidth="1" strokeDasharray="4 3" />
            {series.map((s) => (
              <circle key={s.key} cx={xs[shown]} cy={s.ys[shown]} r="5" style={{ fill: s.color }} className="stroke-card" strokeWidth="2" />
            ))}
          </svg>
          <div
            role="status"
            data-chart-tooltip=""
            className="pointer-events-none absolute top-0 z-10 min-w-28 max-w-[60%] rounded-lg border border-line bg-card px-2.5 py-1.5 text-xs text-ink shadow-md"
            style={at > 0.5 ? { right: `calc(${(1 - at) * 100}% + 10px)` } : { left: `calc(${at * 100}% + 10px)` }}
          >
            <p className="font-medium text-ink-2">{date}</p>
            <ul className="mt-0.5 space-y-0.5">
              {series.map((s) => (
                <li key={s.key} className="flex items-center justify-between gap-3">
                  <span className="inline-flex min-w-0 items-center gap-1.5">
                    <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: s.color }} />
                    <span className="truncate">{s.key}</span>
                  </span>
                  <span className="font-medium tabular-nums" dir="ltr">{value(s.values[shown])}</span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}

/** "2026-10-09" as "9 Oct 2026" (or its Arabic), any other label as it is. */
function formatDay(day: string, lang: Lang): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
  const d = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString(dateLocale(lang), { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
