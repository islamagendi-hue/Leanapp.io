/**
 * Input rules for hand-edited tracking plans (dashboard and management API).
 * Pure: no database. Names follow the same rules as the generated catalog
 * (docs/events.md "Naming conventions"): snake_case, object_action, past tense.
 */
import { z } from "zod";
import { ValidationError } from "@/lib/errors";
import { SYSTEM_EVENT_NAMES } from "@/modules/ingestion/schema";
import { EVENT_LIBRARY } from "./catalog/events";
import { isVolatilePropertyName } from "./catalog/properties";
import { similarity } from "./similarity";

export const EVENT_NAME_RE = /^[a-z][a-z0-9_]{1,63}$/;
export const PROPERTY_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

export const EVENT_PROPERTY_TYPES = ["string", "number", "integer", "boolean", "array", "object", "currency", "datetime"] as const;
export const USER_PROPERTY_TYPES = ["string", "number", "integer", "boolean", "array", "datetime"] as const;
export const EVENT_SOURCES = ["mobile_sdk", "backend", "both", "automatic"] as const;
export const PRIORITIES = ["critical", "high", "medium", "low"] as const;
export const USER_PROPERTY_SOURCES = ["mobile_sdk", "backend", "both", "automatic", "computed"] as const;
export const PLATFORMS = ["android", "ios", "web", "react_native", "flutter", "backend"] as const;

/** Names the SDK uses for identify / alias / push-token calls: a plan must not redefine them. */
const RESERVED_EVENT_NAMES = new Set(Object.values(SYSTEM_EVENT_NAMES).filter((n) => n !== "screen_viewed"));
/** Fields every event already carries on the wire; a property with the same name would be ambiguous. */
const RESERVED_PROPERTY_NAMES = new Set(["event_id", "event_name", "type", "user_id", "anonymous_id", "timestamp", "session_id", "context", "properties", "user_properties"]);

const PAST_TENSE = /(ed|sent|seen|shown|done|won|lost|begun|paid|made|read|given|taken|written|left|set|met|built|sold|bought|got|gotten|out|in|up)$/;

export interface NameCheck {
  warnings: string[];
  /** Closest library event when the name looks like one (for "did you mean"). */
  similar: string | null;
}

/** Throws for names the plan can't hold; returns non-blocking advice otherwise. */
export function checkEventName(name: string): NameCheck {
  if (!EVENT_NAME_RE.test(name)) {
    throw new ValidationError("Event names are snake_case: start with a lowercase letter, then lowercase letters, digits or _ (2–64 characters).");
  }
  if (RESERVED_EVENT_NAMES.has(name)) throw new ValidationError(`${name} is sent by the SDK for identify / alias / push-token calls and can't be planned as a custom event.`);
  if (/__|_$/.test(name)) throw new ValidationError("Event names can't contain double underscores or end with _.");
  const warnings: string[] = [];
  const parts = name.split("_");
  if (parts.length < 2) warnings.push("Use object_action, e.g. order_completed, so related events group together.");
  else if (!PAST_TENSE.test(parts[parts.length - 1])) warnings.push("Name the action in the past tense (…_viewed, …_completed): events record something that happened.");
  let similar: string | null = null;
  if (!EVENT_LIBRARY[name]) {
    let best = 0;
    for (const lib of Object.keys(EVENT_LIBRARY)) {
      // Synonyms make order_* and purchase_* equal; the literal words break the tie.
      const words = new Set(lib.split("_"));
      const s = similarity(name, lib) + 0.01 * parts.filter((w) => words.has(w)).length;
      if (s > best) {
        best = s;
        similar = lib;
      }
    }
    if (best < 0.75) similar = null;
    if (similar) warnings.push(`Looks like the standard event ${similar}. Use the standard name if it means the same thing.`);
  }
  return { warnings, similar };
}

export function checkPropertyName(name: string, kind: "event" | "user"): string[] {
  if (!PROPERTY_NAME_RE.test(name)) throw new ValidationError("Property names are snake_case: start with a lowercase letter, then lowercase letters, digits or _ (≤64 characters).");
  if (kind === "event" && RESERVED_PROPERTY_NAMES.has(name)) throw new ValidationError(`${name} is a top-level event field, not a property.`);
  if (kind === "user" && isVolatilePropertyName(name)) {
    throw new ValidationError(`${name} describes an action, not the person. Make it an event property instead.`);
  }
  return [];
}

const text = (max: number) => z.string().trim().max(max);
const example = z.union([z.string().max(200), z.number().finite(), z.boolean()]).nullable().optional();

export const eventPropertyInput = z.object({
  name: z.string().trim(),
  type: z.enum(EVENT_PROPERTY_TYPES, "Unknown property type."),
  required: z.boolean().default(false),
  description: text(500).default(""),
  allowed_values: z.array(z.string().trim().min(1).max(100)).max(50).nullable().optional(),
  example,
});
export type EventPropertyInput = z.infer<typeof eventPropertyInput>;

const eventFields = {
  display_name: text(100).optional(),
  description: text(1000).optional(),
  category: text(40).optional(),
  trigger: text(500).optional(),
  source: z.enum(EVENT_SOURCES, "Unknown source.").optional(),
  priority: z.enum(PRIORITIES, "Unknown priority.").optional(),
  required: z.boolean().optional(),
  platforms: z.array(z.enum(PLATFORMS, "Unknown platform.")).max(PLATFORMS.length).optional(),
  revenue_relevance: z.boolean().optional(),
  conversion_relevance: z.boolean().optional(),
  attribution_relevance: z.boolean().optional(),
  automation_relevance: z.boolean().optional(),
};

export const newEventInput = z.object({
  event_name: z.string().trim(),
  ...eventFields,
  reason: text(500).optional(),
  properties: z.array(eventPropertyInput).max(50).optional(),
});
export type NewEventInput = z.infer<typeof newEventInput>;

export const eventUpdateInput = z.object(eventFields).refine((o) => Object.values(o).some((v) => v !== undefined), "Nothing to change.");
export type EventUpdateInput = z.infer<typeof eventUpdateInput>;

export const userPropertyInput = z.object({
  name: z.string().trim(),
  type: z.enum(USER_PROPERTY_TYPES, "Unknown user property type."),
  description: text(500).default(""),
  source: z.enum(USER_PROPERTY_SOURCES, "Unknown source.").default("mobile_sdk"),
  reason: text(500).default("Added by hand."),
});
export type UserPropertyInput = z.infer<typeof userPropertyInput>;

/** Parses with a zod schema, turning the first issue into a ValidationError. */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const r = schema.safeParse(input);
  if (!r.success) {
    const issue = r.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    throw new ValidationError(`${where}${issue?.message ?? "Invalid input."}`);
  }
  return r.data;
}

/** Validates a property list (names, duplicates, enum values only on strings). */
export function checkProperties(props: EventPropertyInput[]): void {
  const seen = new Set<string>();
  for (const p of props) {
    checkPropertyName(p.name, "event");
    if (seen.has(p.name)) throw new ValidationError(`Property ${p.name} is listed twice.`);
    seen.add(p.name);
    if (p.allowed_values?.length && p.type !== "string") throw new ValidationError(`Allowed values only apply to string properties (${p.name} is ${p.type}).`);
  }
}

/** "order_completed" → "Order Completed". */
export function displayName(eventName: string): string {
  return eventName.split("_").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
}
