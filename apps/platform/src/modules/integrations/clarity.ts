import { msg } from "@/i18n/translate";
import { defaultClassifier, ProviderError, requestJson, type Classifier, type HttpOptions } from "./ads/http";

/**
 * Microsoft Clarity: the Data Export API adapter and the pure helpers around
 * it (no database; unit-tested in clarity.test.ts). The service with the
 * database side is ./clarity-service.ts. docs/clarity-integration.md.
 *
 * Request (from Microsoft's documentation, "Clarity Data Export API"):
 *   GET https://www.clarity.ms/export-data/api/v1/project-live-insights?numOfDays=1..3&dimension1=URL
 *   Authorization: Bearer <token made in Clarity under Settings → Data Export>
 * Limits: 10 requests per project per day, the last 1 to 3 days only, up to
 * 3 dimensions, at most 1,000 rows and no paging.
 *
 * Response: the documentation shows only a partial sample (an array of
 * { metricName, information: [...] }, counts as strings) and says more fields
 * may appear. Parsing is defensive: unknown metrics and fields are kept as
 * they come, nothing else is assumed. Not verified against the live API.
 */

export const CLARITY_PROVIDER = "microsoft_clarity";
/** The capability row the import runs on (integration_capabilities.capability). */
export const CLARITY_IMPORT_CAPABILITY = "clarity_metrics_import";
export const CLARITY_HOST = "www.clarity.ms";
export const CLARITY_ENDPOINT = `https://${CLARITY_HOST}/export-data/api/v1/project-live-insights`;
/** Clarity's own limit, per project and day (UTC is assumed: Clarity reports in UTC). */
export const CLARITY_DAILY_LIMIT = 10;
/** The dimensions each import asks for, one request each. */
export const CLARITY_DIMENSIONS = ["URL", "Device", "Source"] as const;
export type ClarityDimension = (typeof CLARITY_DIMENSIONS)[number];
/** Every dimension Clarity documents (the import uses CLARITY_DIMENSIONS). */
export const CLARITY_ALL_DIMENSIONS = ["Browser", "Device", "Country/Region", "OS", "Source", "Medium", "Campaign", "Channel", "URL"] as const;
/** Requests one import makes. */
export const REQUESTS_PER_IMPORT = CLARITY_DIMENSIONS.length;
/** The custom tag the web SDK sets (sdks/javascript/src/clarity.ts). */
export const CLARITY_ANONYMOUS_TAG = "leanapp_anonymous_id";
const MAX_ROWS = 1000;

export const isClarityDimension = (v: unknown): v is ClarityDimension => typeof v === "string" && (CLARITY_DIMENSIONS as readonly string[]).includes(v);

/** Clarity project ids are short lowercase letters and digits (e.g. "3t0wlogvdz"). */
export const PROJECT_ID_PATTERN = /^[a-z0-9]{6,20}$/;

export function normalizeProjectId(v: string | undefined | null): string | null {
  const s = (v ?? "").trim().toLowerCase();
  return s ? s : null;
}

/**
 * The customer's Clarity project in Clarity's web app. Only the project
 * page: Clarity documents no URL for recordings filtered by a custom tag, so
 * the UI says to filter by `leanapp_anonymous_id` there.
 */
export function clarityProjectUrl(projectId: string): string | null {
  return PROJECT_ID_PATTERN.test(projectId) ? `https://clarity.microsoft.com/projects/view/${projectId}/dashboard` : null;
}

export function insightsUrl(numOfDays: number, dimension: ClarityDimension): string {
  const days = Math.min(Math.max(Math.trunc(numOfDays) || 1, 1), 3);
  return `${CLARITY_ENDPOINT}?${new URLSearchParams({ numOfDays: String(days), dimension1: dimension })}`;
}

/** Clarity's documented errors: 400 bad parameters, 401 bad token, 403 not allowed, 429 daily limit used up. */
export const clarityClassifier: Classifier = (status, body) => {
  if (status === 429) return new ProviderError("rate_limited", "Clarity's daily limit of 10 requests for this project is used up (HTTP 429). The next import runs tomorrow (UTC).", 429);
  if (status === 401) return new ProviderError("auth", "Clarity refused the API token (HTTP 401): it is missing, wrong or expired. Generate a new one under Settings → Data Export.", 401);
  if (status === 403) return new ProviderError("auth", "Clarity says this token may not export data (HTTP 403).", 403);
  return defaultClassifier(status, body);
};

/**
 * One Data Export request. No automatic retry: every attempt counts against
 * the project's 10 requests a day, so a failure waits for the next run.
 */
export async function fetchInsights(token: string, numOfDays: number, dimension: ClarityDimension, http: HttpOptions = {}): Promise<unknown> {
  if (!token.trim()) throw new ProviderError("config", "No Clarity API token stored.");
  return requestJson<unknown>(
    { url: insightsUrl(numOfDays, dimension), headers: { Authorization: `Bearer ${token.trim()}`, "Content-Type": "application/json" }, allowedHosts: [CLARITY_HOST] },
    clarityClassifier,
    { ...http, maxAttempts: 1 },
  );
}

export interface InsightRow {
  /** Clarity's metricName as given (e.g. "Traffic"). */
  metric: string;
  /** The value of the requested dimension; "" when the row has none. */
  dimensionValue: string;
  /** Numeric fields only (numbers or numeric strings), as named by Clarity. */
  values: Record<string, number>;
}

const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(v.trim())) {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

/** URLs lose their query string and fragment (they can carry personal data); every value is capped. */
export function cleanDimensionValue(dimension: ClarityDimension, v: unknown): string {
  if (typeof v !== "string" && typeof v !== "number") return "";
  let s = String(v).trim();
  if (dimension === "URL") s = s.replace(/[?#].*$/, "");
  return s.slice(0, 500);
}

/** The dimension field of a row, matched without regard to case (Clarity's sample uses the dimension name as the key). */
function dimensionField(info: Record<string, unknown>, dimension: string): string | null {
  if (dimension in info) return dimension;
  const lower = dimension.toLowerCase();
  return Object.keys(info).find((k) => k.toLowerCase() === lower) ?? null;
}

/**
 * Parses a Data Export response into rows. Anything that isn't the documented
 * shape is skipped; a body that isn't an array at all is an error.
 */
export function parseInsights(body: unknown, dimension: ClarityDimension): InsightRow[] {
  if (!Array.isArray(body)) throw new ProviderError("permanent", "Clarity answered with an unexpected format (expected a list of metrics).");
  const out = new Map<string, InsightRow>();
  for (const block of body.slice(0, 100)) {
    if (!block || typeof block !== "object") continue;
    const { metricName, information } = block as { metricName?: unknown; information?: unknown };
    if (typeof metricName !== "string" || !metricName.trim() || !Array.isArray(information)) continue;
    const metric = metricName.trim().slice(0, 100);
    for (const info of information.slice(0, MAX_ROWS)) {
      if (!info || typeof info !== "object" || Array.isArray(info)) continue;
      const rec = info as Record<string, unknown>;
      const field = dimensionField(rec, dimension);
      const dimensionValue = field ? cleanDimensionValue(dimension, rec[field]) : "";
      const values: Record<string, number> = {};
      for (const [k, v] of Object.entries(rec)) {
        if (k === field || k.length > 100) continue;
        const n = num(v);
        if (n !== null) values[k] = n;
      }
      const key = `${metric}\u0000${dimensionValue}`;
      const cur = out.get(key);
      // Two rows for one value (e.g. URLs that differed only in their query string): counts add up.
      if (cur) for (const [k, v] of Object.entries(values)) cur.values[k] = (cur.values[k] ?? 0) + v;
      else out.set(key, { metric, dimensionValue, values });
    }
  }
  return [...out.values()];
}

/** Metric names normalised for matching ("Dead Click Count" → "deadclickcount"). */
export const metricKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

export interface MetricSpec {
  key: string;
  label: string;
  /** Fields to show, first present wins; else the first numeric field. */
  fields: string[];
}

/**
 * The metrics the Clarity card shows, in order. Field names other than
 * Traffic's are not in Microsoft's published sample, so each falls back to
 * the first numeric field the row has, and the UI names the field it shows.
 */
export const METRICS: MetricSpec[] = [
  { key: "traffic", label: msg("Sessions"), fields: ["totalSessionCount"] },
  { key: "scrolldepth", label: msg("Scroll depth"), fields: ["averageScrollDepth", "scrollDepth"] },
  { key: "engagementtime", label: msg("Engagement time"), fields: ["activeTime", "totalTime"] },
  { key: "deadclickcount", label: msg("Dead clicks"), fields: ["sessionsWithMetricPercentage", "subTotal", "sessionsCount"] },
  { key: "rageclickcount", label: msg("Rage clicks"), fields: ["sessionsWithMetricPercentage", "subTotal", "sessionsCount"] },
  { key: "quickbackclick", label: msg("Quickbacks"), fields: ["sessionsWithMetricPercentage", "subTotal", "sessionsCount"] },
  { key: "excessivescroll", label: msg("Excessive scrolling"), fields: ["sessionsWithMetricPercentage", "subTotal", "sessionsCount"] },
  { key: "scripterrorcount", label: msg("Script errors"), fields: ["sessionsWithMetricPercentage", "subTotal", "sessionsCount"] },
  { key: "errorclickcount", label: msg("Error clicks"), fields: ["sessionsWithMetricPercentage", "subTotal", "sessionsCount"] },
];

/** The field shown for a metric row: a preferred one when present, else the first numeric field by name. */
export function shownField(spec: MetricSpec | undefined, values: Record<string, number>): string | null {
  for (const f of spec?.fields ?? []) if (f in values) return f;
  const keys = Object.keys(values).sort();
  return keys[0] ?? null;
}

export const specFor = (metric: string) => METRICS.find((m) => m.key === metricKey(metric));

// ── Request budget ──────────────────────────────────────────────────────────
export const utcDay = (d: Date) => d.toISOString().slice(0, 10);

/** Start of the next UTC day plus `hourUtc` hours: when the daily import runs next. */
export function nextDailyRun(now: Date, hourUtc = 1): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, hourUtc));
  return d;
}

/** Whether an import (REQUESTS_PER_IMPORT requests) fits in what is left of today's limit. */
export function budgetAllows(usedToday: number, limit = CLARITY_DAILY_LIMIT): boolean {
  return usedToday + REQUESTS_PER_IMPORT <= limit;
}
