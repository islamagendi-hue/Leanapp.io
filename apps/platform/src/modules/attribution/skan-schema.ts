/**
 * SKAdNetwork 4 / AdAttributionKit conversion value schema (pure).
 *
 * One schema per app, edited in the dashboard and served to the iOS SDK
 * (GET /v1/skan/conversion-schema). evaluateConversion() is the reference
 * implementation of the rules below, tested with the vectors in
 * test/fixtures/conversion-schema-vectors.json. The iOS SDK doesn't apply
 * schemas yet (not built).
 *
 *   windows   0: 0–48 h after install, 1: 48 h–7 days, 2: 7–35 days (Apple's three conversion windows)
 *   rule      { window, event?, min_revenue?, max_revenue?, fine?, coarse?, lock? }
 *             matches when the event has that name (if set) and the window's
 *             cumulative revenue in the schema currency is ≥ min and < max (if set).
 *   values    only go up within a window: fine = highest matching fine (0–63,
 *             window 0 only), coarse = highest of low < medium < high. A
 *             matching rule with lock: true locks the window.
 */
import { z } from "zod";
import { msg } from "@/i18n/translate";

export const COARSE = ["low", "medium", "high"] as const;
export type Coarse = (typeof COARSE)[number];
const rank = (c: Coarse | null) => (c ? COARSE.indexOf(c) : -1);

const EVENT = /^[a-z][a-z0-9_]{0,63}$/;

const ruleSchema = z
  .object({
    window: z.union([z.literal(0), z.literal(1), z.literal(2)], "window must be 0, 1 or 2."),
    event: z.string().regex(EVENT, "event must be a snake_case event name.").optional(),
    min_revenue: z.number().min(0).max(1e9).optional(),
    max_revenue: z.number().min(0).max(1e9).optional(),
    fine: z.number().int().min(0, "fine values are 0–63.").max(63, "fine values are 0–63.").optional(),
    coarse: z.enum(COARSE, "coarse is low, medium or high.").optional(),
    lock: z.boolean().optional(),
  })
  .strict()
  .refine((r) => r.event !== undefined || r.min_revenue !== undefined || r.max_revenue !== undefined, msg("Each rule needs an event or a revenue range."))
  .refine((r) => r.fine !== undefined || r.coarse !== undefined, msg("Each rule sets a fine or a coarse value."))
  .refine((r) => r.fine === undefined || r.window === 0, msg("Fine values are only sent in the first window (window 0); use coarse for windows 1 and 2."))
  .refine((r) => r.min_revenue === undefined || r.max_revenue === undefined || r.min_revenue < r.max_revenue, "min_revenue must be below max_revenue.");

export const conversionSchemaSchema = z
  .object({
    currency: z.string().regex(/^[A-Z]{3}$/, "currency is a 3-letter code such as SAR or USD.").optional(),
    rules: z.array(ruleSchema).min(1, msg("Add at least one rule.")).max(200, msg("At most 200 rules.")),
  })
  .strict()
  .refine((s) => s.currency !== undefined || s.rules.every((r) => r.min_revenue === undefined && r.max_revenue === undefined), msg("Set currency to use revenue ranges."));

export type ConversionRule = z.infer<typeof ruleSchema>;
export type ConversionSchema = z.infer<typeof conversionSchemaSchema>;

export interface WindowState {
  revenue: number;
  fine: number | null;
  coarse: Coarse | null;
  locked: boolean;
}
export type ConversionState = Partial<Record<0 | 1 | 2, WindowState>>;

export interface ConversionUpdate {
  window: 0 | 1 | 2;
  fine: number;
  coarse: Coarse;
  lock: boolean;
}

const HOUR = 3_600_000;
/** Apple's conversion window for a moment after install, or null after 35 days. */
export function windowFor(installAtMs: number, nowMs: number): 0 | 1 | 2 | null {
  const h = (nowMs - installAtMs) / HOUR;
  if (h < 0) return 0;
  if (h < 48) return 0;
  if (h < 168) return 1;
  if (h < 840) return 2;
  return null;
}

/**
 * Applies one tracked event to the state. Returns the new state and the
 * update to hand to SKAdNetwork / AdAttributionKit, or null when nothing changes.
 */
export function evaluateConversion(
  schema: ConversionSchema,
  state: ConversionState,
  event: { name: string; revenue?: number | null; currency?: string | null },
  installAtMs: number,
  nowMs: number,
): { state: ConversionState; update: ConversionUpdate | null } {
  const w = windowFor(installAtMs, nowMs);
  if (w === null) return { state, update: null };
  const prev: WindowState = state[w] ?? { revenue: 0, fine: null, coarse: null, locked: false };
  if (prev.locked) return { state, update: null };
  const ws: WindowState = { ...prev };
  if (schema.currency && typeof event.revenue === "number" && Number.isFinite(event.revenue) && (event.currency ?? "").toUpperCase() === schema.currency) {
    ws.revenue += event.revenue;
  }
  let fine: number | null = null;
  let coarse: Coarse | null = null;
  let lock = false;
  for (const r of schema.rules) {
    if (r.window !== w) continue;
    if (r.event !== undefined && r.event !== event.name) continue;
    if (r.min_revenue !== undefined && !(ws.revenue >= r.min_revenue)) continue;
    if (r.max_revenue !== undefined && !(ws.revenue < r.max_revenue)) continue;
    if (r.fine !== undefined && (fine === null || r.fine > fine)) fine = r.fine;
    if (r.coarse !== undefined && rank(r.coarse) > rank(coarse)) coarse = r.coarse;
    if (r.lock) lock = true;
  }
  const newFine = fine !== null && (ws.fine === null || fine > ws.fine) ? fine : ws.fine;
  const newCoarse = rank(coarse) > rank(ws.coarse) ? coarse : ws.coarse;
  const changed = newFine !== ws.fine || newCoarse !== ws.coarse || lock;
  ws.fine = newFine;
  ws.coarse = newCoarse;
  ws.locked = lock;
  const next = { ...state, [w]: ws };
  if (!changed) return { state: next, update: null };
  return { state: next, update: { window: w, fine: w === 0 ? newFine ?? 0 : 0, coarse: newCoarse ?? "low", lock } };
}

/** Parses a schema from the dashboard (JSON text) or the API; errors carry the first problem's path. */
export function parseConversionSchema(input: unknown): { ok: true; schema: ConversionSchema } | { ok: false; message: string } {
  let value = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch {
      return { ok: false, message: msg("The schema is not valid JSON.") };
    }
  }
  const r = conversionSchemaSchema.safeParse(value);
  if (r.success) return { ok: true, schema: r.data };
  const i = r.error.issues[0];
  const where = i?.path.length ? `${i.path.join(".")}: ` : "";
  return { ok: false, message: `${where}${i?.message ?? msg("Invalid schema.")}` };
}

/** A starting schema for a typical app: install → signup → purchase revenue tiers. */
export const EXAMPLE_SCHEMA: ConversionSchema = {
  currency: "SAR",
  rules: [
    { window: 0, event: "app_installed", fine: 1, coarse: "low" },
    { window: 0, event: "signup_completed", fine: 8, coarse: "medium" },
    { window: 0, min_revenue: 0.01, max_revenue: 50, fine: 20, coarse: "high" },
    { window: 0, min_revenue: 50, max_revenue: 200, fine: 40, coarse: "high" },
    { window: 0, min_revenue: 200, fine: 63, coarse: "high" },
    { window: 1, event: "signup_completed", coarse: "medium" },
    { window: 1, min_revenue: 0.01, coarse: "high" },
    { window: 2, min_revenue: 0.01, coarse: "high", lock: true },
  ],
};
