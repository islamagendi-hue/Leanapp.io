/** The numbers in a formatted value, and the text around them, for CountUp. */
export type Counted = { parts: (string | { value: number; decimals: number; grouped: boolean })[] };

const NUMBER = /\d+(?:,\d{3})*(?:\.\d+)?/g;

/** Splits "1,234 · 12.5%" into text and numbers; null when there is no number to count. */
export function parseCount(text: string): Counted | null {
  const parts: Counted["parts"] = [];
  let last = 0;
  let any = false;
  for (const m of text.matchAll(NUMBER)) {
    const raw = m[0];
    const value = Number(raw.replaceAll(",", ""));
    if (!Number.isFinite(value)) return null;
    if (m.index > last) parts.push(text.slice(last, m.index));
    const dot = raw.indexOf(".");
    // A long number written without separators keeps none (e.g. a year); short ones can't tell, so group.
    const grouped = raw.includes(",") || raw.slice(0, dot < 0 ? undefined : dot).length < 4;
    parts.push({ value, decimals: dot < 0 ? 0 : raw.length - dot - 1, grouped });
    last = m.index + raw.length;
    any = any || value !== 0;
  }
  if (!any) return null;
  if (last < text.length) parts.push(text.slice(last));
  return { parts };
}

/** The text at `progress` (0 to 1) of the count: each number scaled, formatted like the final one. */
export function countFrame(c: Counted, progress: number): string {
  return c.parts
    .map((p) => {
      if (typeof p === "string") return p;
      const fixed = (p.value * progress).toFixed(p.decimals);
      if (!p.grouped) return fixed;
      const [int, frac] = fixed.split(".");
      const g = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
      return frac === undefined ? g : `${g}.${frac}`;
    })
    .join("");
}
