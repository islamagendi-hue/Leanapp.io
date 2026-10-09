/**
 * What an experiment is, and how the dashboard form becomes one. Pure and
 * client-safe (no database), so the rules can be unit tested.
 *
 * - Variants: a control and 1 to 4 treatments, each with a key the app's code
 *   uses, a name people read, and a weight (the share of traffic it gets).
 * - Traffic: the percentage of eligible people who enter the experiment.
 * - Audience (optional): only members of an active audience are eligible.
 * - Goal: a counted event, optionally with one property filter, done within
 *   N days of the person's first exposure.
 * - Secondary metric (optional): another event, or revenue by the revenue
 *   rules of Analytics → Revenue.
 */
import { msg } from "@/i18n/translate";
import { propertyFilterSchema, PROPERTY_OPS, type PropertyFilter } from "@/modules/analytics/sql";

export const EXPOSURE_EVENT = "experiment_exposure";
export const MAX_VARIANTS = 5;
export const WINDOW_DAYS = [1, 3, 7, 14, 30] as const;
export const DEFAULT_WINDOW_DAYS = 7;
export const STATUSES = ["draft", "running", "stopped"] as const;
export type ExperimentStatus = (typeof STATUSES)[number];

export interface Variant {
  key: string;
  name: string;
  weight: number;
}

export interface Goal {
  event: string;
  filter: PropertyFilter | null;
  window_days: number;
}

export type Secondary = { kind: "event"; event: string } | { kind: "revenue" } | null;

export interface ExperimentDefinition {
  key: string;
  name: string;
  hypothesis: string | null;
  variants: Variant[];
  trafficPercent: number;
  audienceId: string | null;
  goal: Goal;
  secondary: Secondary;
}

export class ExperimentError extends Error {}

/** Form fields as strings (FormData), all optional until validated. */
export type ExperimentForm = Partial<Record<string, string>>;

const KEY = /^[a-z][a-z0-9_]{1,59}$/;
const VARIANT_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const EVENT = /^[A-Za-z][A-Za-z0-9_ .:\-]{0,99}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const str = (v: string | undefined) => (v ?? "").trim();

function fail(message: string): never {
  throw new ExperimentError(message);
}

/** Turns the form into a definition, or throws ExperimentError with a message the form shows. */
export function buildExperiment(f: ExperimentForm): ExperimentDefinition {
  const name = str(f.name);
  if (name.length < 2 || name.length > 80) fail(msg("Name the experiment (2 to 80 characters)."));
  const key = str(f.key).toLowerCase();
  if (!KEY.test(key)) fail(msg("The key starts with a letter and uses lowercase letters, digits and _ (2 to 60)."));
  const hypothesis = str(f.hypothesis);
  if (hypothesis.length > 1000) fail(msg("Keep the hypothesis under 1,000 characters."));

  const variants: Variant[] = [];
  for (let i = 0; i < MAX_VARIANTS; i++) {
    const vKey = str(f[`variantKey${i}`]).toLowerCase();
    const vName = str(f[`variantName${i}`]);
    const vWeight = str(f[`variantWeight${i}`]);
    if (!vKey && !vName && i >= 2) continue;
    if (!VARIANT_KEY.test(vKey)) fail(msg("Each variant needs a key: a lowercase letter first, then letters, digits or _."));
    const weight = Number(vWeight || "0");
    if (!Number.isInteger(weight) || weight < 1 || weight > 1000) fail(msg("Each variant's weight is a whole number from 1 to 1,000."));
    if (variants.some((v) => v.key === vKey)) fail(msg("Variant keys must be different."));
    variants.push({ key: vKey, name: (vName || vKey).slice(0, 60), weight });
  }
  if (variants.length < 2) fail(msg("Add a control and at least one variant."));

  const traffic = Number(str(f.traffic) || "100");
  if (!Number.isInteger(traffic) || traffic < 1 || traffic > 100) fail(msg("Traffic is a whole percentage from 1 to 100."));

  const audienceId = str(f.audienceId) || null;
  if (audienceId && !UUID.test(audienceId)) fail(msg("Choose an audience from the list."));

  const goalEvent = str(f.goalEvent);
  if (!EVENT.test(goalEvent)) fail(msg("Choose the goal event."));
  if (goalEvent === EXPOSURE_EVENT) fail(msg("The goal can't be the exposure event itself."));
  const windowDays = Number(str(f.goalWindow) || String(DEFAULT_WINDOW_DAYS));
  if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 90) fail(msg("The goal window is 1 to 90 days."));
  let filter: PropertyFilter | null = null;
  if (str(f.goalFilterName)) {
    const parsed = propertyFilterSchema.safeParse({ name: str(f.goalFilterName), op: str(f.goalFilterOp) || "eq", value: str(f.goalFilterValue) });
    if (!parsed.success) fail(parsed.error.issues[0]?.message ?? msg("Check the goal's property filter."));
    filter = parsed.data;
  }

  let secondary: Secondary = null;
  const kind = str(f.secondaryKind);
  if (kind === "revenue") secondary = { kind: "revenue" };
  else if (kind === "event") {
    const event = str(f.secondaryEvent);
    if (!EVENT.test(event)) fail(msg("Choose the secondary event."));
    secondary = { kind: "event", event };
  } else if (kind && kind !== "none") fail(msg("Choose a secondary metric from the list."));

  return { key, name, hypothesis: hypothesis || null, variants, trafficPercent: traffic, audienceId, goal: { event: goalEvent, filter, window_days: windowDays }, secondary };
}

/** The form values of a saved experiment (to edit it). */
export function formOf(d: ExperimentDefinition): ExperimentForm {
  const out: ExperimentForm = {
    name: d.name, key: d.key, hypothesis: d.hypothesis ?? "", traffic: String(d.trafficPercent), audienceId: d.audienceId ?? "",
    goalEvent: d.goal.event, goalWindow: String(d.goal.window_days),
    goalFilterName: d.goal.filter?.name ?? "", goalFilterOp: d.goal.filter?.op ?? "eq", goalFilterValue: d.goal.filter?.value ?? "",
    secondaryKind: d.secondary?.kind ?? "none", secondaryEvent: d.secondary?.kind === "event" ? d.secondary.event : "",
  };
  d.variants.forEach((v, i) => {
    out[`variantKey${i}`] = v.key;
    out[`variantName${i}`] = v.name;
    out[`variantWeight${i}`] = String(v.weight);
  });
  return out;
}

/** Starting values for a new experiment: control and one treatment, 50/50, everyone. */
export const NEW_FORM: ExperimentForm = {
  variantKey0: "control", variantName0: "Control", variantWeight0: "50",
  variantKey1: "treatment", variantName1: "Treatment", variantWeight1: "50",
  traffic: "100", goalWindow: String(DEFAULT_WINDOW_DAYS), goalFilterOp: "eq", secondaryKind: "none",
};

/** Reads the stored jsonb columns back into a definition (rows written by buildExperiment). */
export function definitionOf(row: {
  key: string; name: string; hypothesis: string | null; variants: unknown; traffic_percent: number; audience_id: string | null; goal: unknown; secondary: unknown;
}): ExperimentDefinition {
  const goal = row.goal as Goal;
  return {
    key: row.key,
    name: row.name,
    hypothesis: row.hypothesis,
    variants: row.variants as Variant[],
    trafficPercent: row.traffic_percent,
    audienceId: row.audience_id,
    goal: { event: goal.event, filter: goal.filter ?? null, window_days: goal.window_days ?? DEFAULT_WINDOW_DAYS },
    secondary: (row.secondary as Secondary) ?? null,
  };
}

export const OP_OPTIONS = PROPERTY_OPS;
