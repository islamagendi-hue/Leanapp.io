/**
 * Wire format for POST /v1/events and /v1/events/batch. Shared by every SDK.
 * Field names are snake_case on the wire. See docs/events.md.
 */
import { z } from "zod";

export const LIMITS = {
  maxBatchEvents: 500,
  maxBatchBytes: 1_000_000,
  maxEventBytes: 64_000,
  maxPropertiesBytes: 32_000,
  maxPropertyKeys: 255,
  maxDepth: 4,
  maxPastDays: 31,
  maxFutureMinutes: 10,
} as const;

export const EVENT_TYPES = ["track", "screen", "identify", "alias", "push_token", "consent"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** Event names the SDKs emit for non-track calls. */
export const SYSTEM_EVENT_NAMES: Record<Exclude<EventType, "track">, string> = {
  screen: "screen_viewed",
  identify: "user_identified",
  alias: "user_aliased",
  push_token: "push_token_registered",
  consent: "consent_updated",
};

const id = z.string().trim().min(1).max(200);

const json: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null(), z.array(json).max(100), z.record(z.string().max(100), json)]),
);
const props = z.record(z.string().min(1).max(100), json);

export const contextSchema = z
  .object({
    platform: z.enum(["android", "ios", "react_native", "flutter", "web", "backend"]).optional(),
    app_version: z.string().max(50).optional(),
    app_build: z.string().max(50).optional(),
    os_version: z.string().max(50).optional(),
    device: z
      .object({
        id: z.string().max(200).optional(),
        model: z.string().max(100).optional(),
        manufacturer: z.string().max(100).optional(),
        type: z.string().max(50).optional(),
      })
      .partial()
      .optional(),
    locale: z.string().max(35).optional(),
    language: z.string().max(35).optional(),
    timezone: z.string().max(64).optional(),
    country: z.string().max(2).optional(),
    sdk: z.object({ name: z.string().max(50), version: z.string().max(30) }).optional(),
    network: z.object({ carrier: z.string().max(100).optional(), wifi: z.boolean().optional() }).partial().optional(),
    screen: z.object({ width: z.number().optional(), height: z.number().optional(), density: z.number().optional() }).partial().optional(),
    attribution: z.record(z.string().max(60), z.string().max(1000)).optional(),
    // Native SDKs: Play Install Referrer details (install_referrer, referrer_click_timestamp_seconds, …). See docs/sdk.md.
    campaign: z.record(z.string().max(60), z.union([z.string().max(1000), z.number().finite(), z.boolean(), z.null()])).optional(),
    consent: z.record(z.string().max(30), z.boolean()).optional(),
  })
  .passthrough();

export const eventSchema = z
  .object({
    type: z.enum(EVENT_TYPES).default("track"),
    event_name: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z][A-Za-z0-9_ .:\-]*$/, "event_name must start with a letter and contain letters, digits, spaces, _ . : -")
      .optional(),
    event_id: id.optional(),
    timestamp: z.string().max(40).optional(),
    anonymous_id: id.optional(),
    user_id: id.optional(),
    previous_id: id.optional(),
    session_id: id.optional(),
    schema_version: z.number().int().min(1).max(1000).default(1),
    properties: props.default({}),
    user_properties: props.optional(),
    context: contextSchema.default({}),
    push_token: z
      .object({
        token: z.string().min(10).max(4096),
        provider: z.enum(["fcm", "apns"]),
        permission: z.enum(["granted", "denied", "provisional", "unknown"]).default("unknown"),
      })
      .optional(),
    /** type "consent": the purposes that changed. Recorded in consent_records, never stored as an event. */
    consent: z
      .object({ analytics: z.boolean(), marketing: z.boolean(), push: z.boolean(), attribution: z.boolean() })
      .partial()
      .strict()
      .optional(),
  })
  .superRefine((e, ctx) => {
    if (e.type === "track" && !e.event_name) ctx.addIssue({ code: "custom", path: ["event_name"], message: "event_name is required for track" });
    if (!e.anonymous_id && !e.user_id) ctx.addIssue({ code: "custom", path: ["anonymous_id"], message: "anonymous_id or user_id is required" });
    if (e.type === "identify" && !e.user_id && !e.user_properties)
      ctx.addIssue({ code: "custom", path: ["user_id"], message: "identify needs user_id or user_properties" });
    if (e.type === "alias" && (!e.user_id || !e.previous_id))
      ctx.addIssue({ code: "custom", path: ["previous_id"], message: "alias needs user_id and previous_id" });
    if (e.type === "push_token" && !e.push_token) ctx.addIssue({ code: "custom", path: ["push_token"], message: "push_token is required" });
    if (e.type === "consent" && (!e.consent || !Object.keys(e.consent).length))
      ctx.addIssue({ code: "custom", path: ["consent"], message: "consent needs at least one of analytics, marketing, push, attribution (booleans)" });
  });

export type IncomingEvent = z.infer<typeof eventSchema>;

export const batchSchema = z.object({
  batch: z.array(z.unknown()).min(1).max(LIMITS.maxBatchEvents),
  sent_at: z.string().max(40).optional(),
});

function depth(v: unknown, d = 0): number {
  if (v === null || typeof v !== "object") return d;
  let max = d + 1;
  for (const x of Object.values(v as object)) max = Math.max(max, depth(x, d + 1));
  return max;
}

export interface NormalizedEvent {
  event_id: string;
  type: EventType;
  event_name: string;
  timestamp: string;
  anonymous_id: string | null;
  user_id: string | null;
  session_id: string | null;
  platform: string | null;
  app_version: string | null;
  os_version: string | null;
  sdk_name: string | null;
  sdk_version: string | null;
  schema_version: number;
  properties: Record<string, unknown>;
  user_properties: Record<string, unknown> | null;
  context: Record<string, unknown>;
  /** Only on type "consent". */
  consent?: Partial<Record<"analytics" | "marketing" | "push" | "attribution", boolean>>;
}

export interface NormalizeIssue {
  field: string;
  message: string;
}

/**
 * Validates and normalizes one raw event. `skew` corrects client clock drift
 * using the batch's sent_at (server_now - sent_at), like other mobile SDKs do.
 */
export function normalizeEvent(
  raw: unknown,
  opts: { now: Date; fallbackEventId: () => string; clockSkewMs?: number },
): { ok: true; event: NormalizedEvent; warnings: NormalizeIssue[] } | { ok: false; errors: NormalizeIssue[] } {
  if (JSON.stringify(raw ?? null).length > LIMITS.maxEventBytes) return { ok: false, errors: [{ field: "", message: "event exceeds 64KB" }] };
  const parsed = eventSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })) };
  }
  const e = parsed.data;
  const errors: NormalizeIssue[] = [];
  const warnings: NormalizeIssue[] = [];

  if (Object.keys(e.properties).length > LIMITS.maxPropertyKeys) errors.push({ field: "properties", message: `more than ${LIMITS.maxPropertyKeys} properties` });
  if (JSON.stringify(e.properties).length > LIMITS.maxPropertiesBytes) errors.push({ field: "properties", message: "properties exceed 32KB" });
  if (depth(e.properties) > LIMITS.maxDepth) errors.push({ field: "properties", message: `properties nested deeper than ${LIMITS.maxDepth} levels` });

  const now = opts.now.getTime();
  let ts = now;
  if (e.timestamp) {
    const t = Date.parse(e.timestamp);
    if (Number.isNaN(t)) errors.push({ field: "timestamp", message: "timestamp must be ISO 8601" });
    else ts = t + (opts.clockSkewMs ?? 0);
  }
  if (ts < now - LIMITS.maxPastDays * 86_400_000) errors.push({ field: "timestamp", message: `timestamp older than ${LIMITS.maxPastDays} days` });
  if (ts > now + LIMITS.maxFutureMinutes * 60_000) {
    warnings.push({ field: "timestamp", message: "timestamp in the future; replaced with receive time" });
    ts = now;
  }
  if (!e.event_id) warnings.push({ field: "event_id", message: "no event_id: retries of this event cannot be de-duplicated" });
  if (errors.length) return { ok: false, errors };

  const name = e.type === "track" ? e.event_name! : SYSTEM_EVENT_NAMES[e.type];
  const properties = { ...e.properties };
  if (e.type === "screen" && e.event_name && properties.screen_name === undefined) properties.screen_name = e.event_name;
  if (e.type === "alias") properties.previous_id = e.previous_id;
  if (e.type === "push_token") properties.provider = e.push_token!.provider;
  const context = { ...e.context } as Record<string, unknown>;
  if (e.push_token) context.push = { token: e.push_token.token, provider: e.push_token.provider, permission: e.push_token.permission };

  return {
    ok: true,
    warnings,
    event: {
      event_id: e.event_id ?? opts.fallbackEventId(),
      type: e.type,
      event_name: name,
      timestamp: new Date(ts).toISOString(),
      anonymous_id: e.anonymous_id ?? null,
      user_id: e.user_id ?? null,
      session_id: e.session_id ?? null,
      platform: e.context.platform ?? null,
      app_version: e.context.app_version ?? null,
      os_version: e.context.os_version ?? null,
      sdk_name: e.context.sdk?.name ?? null,
      sdk_version: e.context.sdk?.version ?? null,
      schema_version: e.schema_version,
      properties,
      user_properties: e.user_properties ?? null,
      context,
      ...(e.type === "consent" ? { consent: e.consent } : {}),
    },
  };
}
