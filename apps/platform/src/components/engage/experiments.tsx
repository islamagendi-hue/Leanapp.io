import { getT } from "@/i18n/server";
import { msg } from "@/i18n/translate";
import type { ExperimentStatus } from "@/modules/experiments/definition";

const PILL: Record<ExperimentStatus, string> = {
  draft: "border-line text-ink-3",
  running: "border-accent/40 bg-accent-soft text-accent-ink",
  stopped: "border-line-strong text-ink-2",
};
const TEXT: Record<ExperimentStatus, string> = { draft: msg("draft"), running: msg("running"), stopped: msg("stopped") };

export async function ExperimentStatusPill({ status }: { status: ExperimentStatus }) {
  const t = await getT();
  return <span className={`pill ${PILL[status]}`}>{t(TEXT[status])}</span>;
}

/** A rate as a percentage with one decimal. */
export const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** A signed change in percent, e.g. +12.3%. */
export const signedPct = (x: number) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x * 100).toFixed(1)}%`;

/** A signed change in percentage points, e.g. +1.2 pp. */
export const signedPoints = (x: number) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x * 100).toFixed(1)}`;

/** A p-value as shown: "< 0.001" or three decimals. */
export const pValueText = (p: number) => (p < 0.001 ? "< 0.001" : p.toFixed(3));
