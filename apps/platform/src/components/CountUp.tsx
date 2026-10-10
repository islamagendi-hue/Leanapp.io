"use client";

import { useEffect, useRef, useState } from "react";
import { countFrame, parseCount } from "./count-up";

const DURATION = 750;

/**
 * A number that counts up from zero once, when it first appears. `value` is the
 * final text exactly as the server formats it ("1,234", "12.5%", "3 · 40%",
 * "−9.99"); every frame keeps its decimals, separators and surrounding text.
 * The server HTML holds the final text (no JavaScript, tests and search see
 * the real number), and people who prefer reduced motion never see it move.
 * The width is held at the final value's while counting, so nothing shifts.
 */
export function CountUp({ value, className = "" }: { value: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [frame, setFrame] = useState<{ text: string; width: number } | null>(null);

  useEffect(() => {
    const parsed = parseCount(value);
    const el = ref.current;
    if (!parsed || !el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const width = el.getBoundingClientRect().width;
    let start = 0;
    let raf = requestAnimationFrame(function tick(now) {
      if (!start) start = now;
      const p = Math.min(1, (now - start) / DURATION);
      if (p >= 1) return setFrame(null);
      setFrame({ text: countFrame(parsed, 1 - Math.pow(1 - p, 3)), width });
      raf = requestAnimationFrame(tick);
    });
    return () => {
      cancelAnimationFrame(raf);
      setFrame(null);
    };
  }, [value]);

  return (
    <span
      ref={ref}
      data-count={value}
      className={`tabular-nums ${frame ? "inline-block" : ""} ${className}`}
      style={frame ? { minWidth: frame.width } : undefined}
    >
      {frame ? frame.text : value}
    </span>
  );
}
