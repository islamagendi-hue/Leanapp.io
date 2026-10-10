import type { ReactNode } from "react";
import { CountUp } from "./CountUp";

/**
 * One key number: a label, the value (counting up once, see CountUp), and
 * optionally its change (a Delta or RateDelta badge) and a short note. Every
 * stat tile in the product uses this, inside a `.stat-grid` (two per row on
 * phones, four on wide screens). `bare` drops the tile, for numbers that sit
 * inside a card that already has one.
 */
export function Stat({ label, value, unit, delta, note, bare = false, small = false }: {
  label?: ReactNode;
  /** The final text as the page formats it ("1,234", "12.5%"). */
  value: string;
  unit?: ReactNode;
  delta?: ReactNode;
  note?: ReactNode;
  bare?: boolean;
  small?: boolean;
}) {
  return (
    <div className={`stat ${bare ? "stat-bare" : ""}`}>
      {label && <p className="stat-label">{label}</p>}
      <p className={`stat-value ${small ? "stat-value-sm" : ""}`}><CountUp value={value} />{unit && <span className="stat-unit">{unit}</span>}</p>
      {delta}
      {note && <p className="stat-note">{note}</p>}
    </div>
  );
}
