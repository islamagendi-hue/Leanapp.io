"use client";

import { useEffect, useId, useRef, useState } from "react";
import { CountUp } from "@/components/CountUp";
import type { LandingCopy } from "@/modules/marketing/landing";

/**
 * The landing page's one product visual: a sample dashboard that builds itself
 * like a short screen recording, made of plain markup and CSS transitions (no
 * video). A cursor adds a report, picks an event, then the key numbers count
 * up, the daily line draws in and the funnel and sources fill. It loops about
 * every 14 seconds.
 *
 * The server renders the finished dashboard, so search, no-JavaScript and
 * people who prefer reduced motion see the complete, still frame. The loop
 * waits while the dashboard is off screen or paused, and the Pause button
 * stops it (WCAG 2.2.2). Logical properties keep it right in RTL.
 */

type Copy = LandingCopy["demo"];

/** Steps of the recording. FINAL is the finished frame the server renders. */
const EMPTY = 0, TO_ADD = 1, PICKER = 2, HOVER = 3, KPIS = 4, LINE = 5, FUNNEL = 6, SOURCES = 7, SAVE = 8, FINAL = 9;
/** How long each step stays on screen, in ms (about 13.6 s a loop with the fade). */
const HOLD = [900, 900, 1000, 700, 1300, 1700, 1500, 1500, 1300, 2400];
const FADE = 450;
const CLICKS = new Set([PICKER, KPIS, SAVE]);

const KPI_VALUES = ["12,480", "8,215", "3,960", "184,300"];
const KPI_DELTAS = ["+18%", "+9%", "+12%", "+15%"];
const EVENTS = ["app_open", "sign_up", "add_to_cart", "order_completed"];
const FUNNEL_PCT = [100, 64, 38, 24];
const SOURCES_PCT = [
  { name: "Meta", pct: 34 },
  { name: "TikTok", pct: 26 },
  { name: "Snapchat", pct: 18 },
  { name: "Google Ads", pct: 12 },
];
const ORGANIC_PCT = 10;

/** 30 days of orders: a weekly rhythm on a rising line. Hand-written so server and client agree. */
const ORDERS = [92, 98, 104, 101, 118, 131, 126, 110, 114, 121, 117, 133, 146, 139, 124, 128, 137, 132, 151, 163, 158, 140, 146, 152, 149, 168, 181, 174, 160, 171];
const W = 300, H = 90;
const MAX = 190, MIN = 80;
const POINTS = ORDERS.map((v, i) => [(i / (ORDERS.length - 1)) * W, H - ((v - MIN) / (MAX - MIN)) * H] as const);
const LINE_PATH = POINTS.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
const AREA_PATH = `${LINE_PATH} L${W} ${H} L0 ${H} Z`;

export function BuildingDashboard({ copy, lang }: { copy: Copy; lang: "en" | "ar" }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const clipId = `orders-line-${useId().replace(/:/g, "")}`;
  const [phase, setPhase] = useState(FINAL);
  const [cycle, setCycle] = useState(0);
  const [fading, setFading] = useState(false);
  const [motion, setMotion] = useState(false);
  const [paused, setPaused] = useState(false);
  const [visible, setVisible] = useState(false);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);

  // Motion only after hydration, and never for people who prefer it reduced.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      setMotion(!mq.matches);
      // Turning motion off mid-loop goes back to the finished frame.
      if (mq.matches) {
        setPhase(FINAL);
        setFading(false);
      }
    };
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // Play only while on screen.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { threshold: 0.25 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const running = motion && visible && !paused;

  useEffect(() => {
    if (!running) return;
    if (fading) {
      const id = setTimeout(() => {
        setCycle((c) => c + 1);
        setPhase(EMPTY);
        setFading(false);
      }, FADE);
      return () => clearTimeout(id);
    }
    const id = setTimeout(() => (phase === FINAL ? setFading(true) : setPhase(phase + 1)), HOLD[phase]);
    return () => clearTimeout(id);
  }, [running, phase, fading]);

  // The cursor goes to the element the step works on, measured, so it lands right at any width and in RTL.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !motion) return;
    const target =
      phase <= EMPTY ? "rest" : phase <= PICKER ? "add" : phase <= KPIS ? "event" : phase === LINE ? "line" : phase === FUNNEL ? "funnel" : phase === SOURCES ? "sources" : "save";
    const el = root.querySelector<HTMLElement>(`[data-cursor="${target}"]`);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const base = root.getBoundingClientRect();
    setCursor({ x: r.left - base.left + r.width * 0.55, y: r.top - base.top + r.height * 0.6 });
  }, [phase, cycle, motion]);

  const on = (step: number) => phase >= step;
  const fmt = (i: number) => (i === 3 ? (lang === "ar" ? `${KPI_VALUES[i]} ${copy.board.currency}` : `${copy.board.currency} ${KPI_VALUES[i]}`) : KPI_VALUES[i]);
  const b = copy.board;
  const showCursor = motion && phase < FINAL && !fading && cursor;

  return (
    <div>
      <div ref={rootRef} role="img" aria-label={copy.alt} className="relative overflow-hidden rounded-2xl border border-line-strong bg-paper shadow-[0_24px_60px_-24px_rgb(14_19_17/0.35)]">
        {/* Window bar */}
        <div aria-hidden className="flex items-center gap-1.5 border-b border-line bg-paper-2 px-4 py-2.5">
          <span className="size-2.5 rounded-full bg-line-strong" />
          <span className="size-2.5 rounded-full bg-line-strong" />
          <span className="size-2.5 rounded-full bg-line-strong" />
          <span className="ms-3 truncate rounded-md bg-card px-3 py-0.5 font-mono text-[11px] text-ink-3" dir="ltr">app.leanapp.io/dashboards</span>
        </div>

        <div aria-hidden className={`p-3 transition-opacity sm:p-5 ${fading ? "opacity-0" : "opacity-100"}`} style={{ transitionDuration: `${FADE}ms` }}>
          <div key={cycle} className="space-y-3">
            {/* Header */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate font-bold leading-tight">{b.title}</p>
                <p className="text-xs text-ink-3">{b.range}</p>
              </div>
              <div className="relative flex items-center gap-2">
                <span
                  data-cursor="add"
                  className={`inline-flex min-h-8 items-center gap-1 rounded-lg border px-2.5 text-xs font-medium transition-colors duration-300 ${on(TO_ADD) && phase <= HOVER ? "border-accent bg-accent-soft text-accent-ink" : "border-line-strong bg-card text-ink"}`}
                >
                  <span className="text-sm leading-none">+</span>
                  {b.add}
                </span>
                <span
                  data-cursor="save"
                  className={`inline-flex min-h-8 items-center gap-1 rounded-lg px-2.5 text-xs font-medium transition-colors duration-300 ${on(SAVE) ? "bg-accent text-paper" : "bg-ink text-paper"}`}
                >
                  {on(SAVE) ? <>✓ {b.saved}</> : b.save}
                </span>

                {/* Event picker */}
                <div
                  className={`absolute end-0 top-full z-10 mt-2 w-52 origin-top rounded-xl border border-line bg-card p-1.5 shadow-lg transition duration-200 ${phase === PICKER || phase === HOVER ? "scale-100 opacity-100" : "pointer-events-none scale-95 opacity-0"}`}
                >
                  <p className="px-2 pb-1 pt-0.5 text-[11px] text-ink-3">{b.pick}</p>
                  {EVENTS.map((e) => {
                    const target = e === "order_completed";
                    return (
                      <p
                        key={e}
                        data-cursor={target ? "event" : undefined}
                        dir="ltr"
                        className={`rounded-md px-2 py-1 text-start font-mono text-[11.5px] transition-colors ${target && on(HOVER) ? "bg-accent-soft text-accent-ink" : "text-ink-2"}`}
                      >
                        {e}
                      </p>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Key numbers */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3">
              {b.kpis.map((label, i) => (
                <Slot key={label} filled={on(KPIS)} delay={i * 110} className="p-3">
                  <p className="truncate text-[11px] text-ink-2 sm:text-xs">{label}</p>
                  <p className="mt-0.5 text-lg font-bold leading-tight tabular-nums sm:text-xl">
                    {on(KPIS) ? <CountUp value={fmt(i)} /> : <span className="text-ink-3">–</span>}
                  </p>
                  <span className="delta delta-up mt-1">{KPI_DELTAS[i]}</span>
                </Slot>
              ))}
            </div>

            {/* Orders per day */}
            <Slot filled={on(LINE)} className="p-3 sm:p-4">
              <p data-cursor="line" className="text-xs font-semibold sm:text-sm">{b.chart}</p>
              <svg viewBox={`0 -4 ${W} ${H + 8}`} preserveAspectRatio="none" className="mt-2 h-20 w-full sm:h-28">
                {[0.25, 0.5, 0.75].map((f) => (
                  <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} stroke="var(--color-line)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
                ))}
                {/* The line draws in from the start of the month: a clip that widens (works with a stretched viewBox). */}
                <clipPath id={clipId}>
                  <rect
                    x="0"
                    y="-4"
                    width={W}
                    height={H + 8}
                    style={{ transform: `scaleX(${on(LINE) ? 1 : 0})`, transformOrigin: "0 0", transition: "transform 1.4s cubic-bezier(.4,0,.2,1)" }}
                  />
                </clipPath>
                <g clipPath={`url(#${clipId})`}>
                  <path d={AREA_PATH} fill="var(--color-chart-1)" opacity="0.14" />
                  <path d={LINE_PATH} fill="none" stroke="var(--color-chart-1)" strokeWidth="2.25" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                </g>
              </svg>
            </Slot>

            <div className="grid gap-3 sm:grid-cols-2">
              {/* Funnel */}
              <Slot filled={on(FUNNEL)} className="p-3 sm:p-4">
                <p data-cursor="funnel" className="text-xs font-semibold sm:text-sm">{b.funnel}</p>
                <div className="mt-3 grid h-24 grid-cols-4 items-end gap-2">
                  {FUNNEL_PCT.map((pct, i) => (
                    <div key={i} className="flex h-full flex-col justify-end">
                      <span className="mb-1 text-center text-[10.5px] font-medium tabular-nums text-ink-2">{pct}%</span>
                      <span
                        className="block rounded-t-md bg-chart-1 transition-[height] duration-700 ease-out"
                        style={{ height: on(FUNNEL) ? `${pct * 0.7}%` : "0%", transitionDelay: `${i * 140}ms`, opacity: 1 - i * 0.16 }}
                      />
                    </div>
                  ))}
                </div>
                <div className="mt-1.5 grid grid-cols-4 gap-2">
                  {b.steps.map((s) => <span key={s} className="truncate text-center text-[10.5px] text-ink-3">{s}</span>)}
                </div>
              </Slot>

              {/* Acquisition by source */}
              <Slot filled={on(SOURCES)} className="p-3 sm:p-4">
                <p data-cursor="sources" className="text-xs font-semibold sm:text-sm">{b.sources}</p>
                <ul className="mt-3 space-y-1.5">
                  {[...SOURCES_PCT, { name: b.organic, pct: ORGANIC_PCT }].map((s, i) => (
                    <li key={s.name} className="grid grid-cols-[5.5rem_1fr_2.25rem] items-center gap-2 text-[11px]">
                      <span className="truncate text-ink-2">{s.name}</span>
                      <span className="h-2 overflow-hidden rounded-full bg-paper-2">
                        <span
                          className="block h-full rounded-full transition-[width] duration-700 ease-out"
                          style={{ width: on(SOURCES) ? `${(s.pct / 34) * 100}%` : "0%", transitionDelay: `${i * 120}ms`, background: `var(--color-chart-${i === 4 ? 6 : i + 1})` }}
                        />
                      </span>
                      <span className="text-end font-medium tabular-nums text-ink-2">{s.pct}%</span>
                    </li>
                  ))}
                </ul>
              </Slot>
            </div>
          </div>
        </div>

        {/* The cursor and its click ring */}
        {motion && cursor && (
          <div
            aria-hidden
            className={`pointer-events-none absolute left-0 top-0 z-20 transition-[translate,opacity] duration-700 ease-in-out ${showCursor ? "opacity-100" : "opacity-0"}`}
            style={{ translate: `${cursor.x}px ${cursor.y}px` }}
          >
            {CLICKS.has(phase) && <span key={`${cycle}-${phase}`} className="landing-click absolute -left-3 -top-3 size-6 rounded-full border-2 border-accent" />}
            <svg width="18" height="22" viewBox="0 0 18 22" className="drop-shadow-sm">
              <path d="M1.5 1.5v16.2l4.3-4 2.7 6.3 2.9-1.2-2.7-6.2h5.8z" fill="var(--color-ink)" stroke="var(--color-paper)" strokeWidth="1.4" strokeLinejoin="round" />
            </svg>
          </div>
        )}
      </div>

      <div className="mt-3 flex min-h-8 flex-wrap items-center justify-between gap-2 text-sm text-ink-3">
        <p>{copy.note}</p>
        {motion && (
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            aria-pressed={paused}
            className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-line bg-card px-3 text-xs font-medium text-ink-2 hover:text-ink"
          >
            <span aria-hidden className="text-[10px]">{paused ? "▶" : "❚❚"}</span>
            {paused ? copy.play : copy.pause}
          </button>
        )}
      </div>
    </div>
  );
}

/** A report's place on the board: a dashed outline until the report arrives, then a card. */
function Slot({ filled, delay = 0, className = "", children }: { filled: boolean; delay?: number; className?: string; children: React.ReactNode }) {
  return (
    <div
      className={`rounded-xl border transition-colors duration-500 ${filled ? "border-line bg-card shadow-card" : "border-dashed border-line-strong bg-transparent"} ${className}`}
      style={{ transitionDelay: `${delay}ms` }}
    >
      <div className={`transition-[opacity,translate] duration-500 ${filled ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0"}`} style={{ transitionDelay: `${delay}ms` }}>
        {children}
      </div>
    </div>
  );
}
