/**
 * A numeric env var, or the fallback when it is unset, empty or not a
 * non-negative number. `Number("")` is 0, so `Number(v ?? n)` would turn an
 * empty `.env` line into a limit of zero.
 */
export function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
