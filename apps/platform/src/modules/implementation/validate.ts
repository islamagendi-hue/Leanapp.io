/**
 * Event schema validation: an actual event payload vs its tracking-plan spec.
 * Used by the background processor (stored results, implementation status)
 * and by the event debugger (live verdict per event).
 */
import { isVolatilePropertyName, type PropertyType } from "./catalog/properties";

export interface SpecProperty {
  name: string;
  type: PropertyType;
  required: boolean;
  allowed_values?: string[] | null;
}

export interface EventSpec {
  event_name: string;
  revenue_relevance?: boolean;
  conversion_relevance?: boolean;
  properties: SpecProperty[];
}

export interface ValidationIssue {
  property?: string;
  code: "missing_required" | "wrong_type" | "invalid_value" | "invalid_currency" | "negative_amount" | "unknown_property" | "not_identified" | "volatile_user_property";
  message: string;
  expected?: string;
  received?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

let currencies: Set<string> | null = null;
export function isCurrencyCode(v: unknown): boolean {
  if (typeof v !== "string" || !/^[A-Z]{3}$/.test(v)) return false;
  if (!currencies) {
    try {
      currencies = new Set((Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("currency"));
    } catch {
      currencies = new Set();
    }
  }
  return currencies.size === 0 || currencies.has(v);
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function matches(type: PropertyType, v: unknown): boolean {
  switch (type) {
    case "string": return typeof v === "string";
    case "number": return typeof v === "number" && Number.isFinite(v);
    case "integer": return typeof v === "number" && Number.isInteger(v);
    case "boolean": return typeof v === "boolean";
    case "array": return Array.isArray(v);
    case "object": return typeof v === "object" && v !== null && !Array.isArray(v);
    case "currency": return typeof v === "string";
    case "datetime": return typeof v === "string" && !Number.isNaN(Date.parse(v));
  }
}

const AMOUNT = /^(revenue|price|value|amount|cart_value|refund_amount|gmv|tax|shipping|discount|delivery_fee|fee)$/;

export function validateEvent(
  spec: EventSpec,
  payload: { properties: Record<string, unknown>; user_id?: string | null; user_properties?: Record<string, unknown> | null },
): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const props = payload.properties ?? {};
  const declared = new Set(spec.properties.map((p) => p.name));

  for (const p of spec.properties) {
    const v = props[p.name];
    if (v === undefined || v === null || v === "") {
      if (p.required) errors.push({ property: p.name, code: "missing_required", message: `${p.name} is required`, expected: p.type, received: "missing" });
      continue;
    }
    if (!matches(p.type, v)) {
      errors.push({ property: p.name, code: "wrong_type", message: `${p.name} should be ${p.type}`, expected: p.type, received: typeOf(v) });
      continue;
    }
    if (p.type === "currency" && !isCurrencyCode(v)) {
      errors.push({ property: p.name, code: "invalid_currency", message: `${p.name} must be an ISO 4217 code like SAR or AED`, expected: "ISO 4217", received: String(v) });
    }
    if (p.allowed_values?.length && typeof v === "string" && !p.allowed_values.includes(v)) {
      warnings.push({ property: p.name, code: "invalid_value", message: `${p.name} is not one of the planned values`, expected: p.allowed_values.join(" | "), received: v });
    }
    if (AMOUNT.test(p.name) && typeof v === "number" && v < 0) {
      errors.push({ property: p.name, code: "negative_amount", message: `${p.name} must not be negative (send refunds as refund events)`, received: String(v) });
    }
  }

  for (const k of Object.keys(props)) {
    if (!declared.has(k) && k !== "screen_name") warnings.push({ property: k, code: "unknown_property", message: `${k} is not in the tracking plan` });
  }
  if ((spec.revenue_relevance || spec.conversion_relevance) && !payload.user_id) {
    warnings.push({ code: "not_identified", message: "Conversion sent without user_id; it can only be attributed through the anonymous id" });
  }
  for (const k of Object.keys(payload.user_properties ?? {})) {
    if (isVolatilePropertyName(k)) {
      warnings.push({ property: k, code: "volatile_user_property", message: `${k} describes an action, not the user. Send it as an event property instead.` });
    }
  }
  return { valid: errors.length === 0, errors, warnings };
}
