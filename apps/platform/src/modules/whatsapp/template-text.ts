/** WhatsApp template text: variables, counting and filling. Pure and client-safe (no Node APIs). */
export interface TemplateComponent {
  type: string;
  format?: string;
  text?: string;
  buttons?: unknown[];
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]{1,64})\s*\}\}/g;

/** Highest {{n}} placeholder in a text (WhatsApp numbers them from 1). */
export function placeholderCount(text: string | undefined): number {
  let max = 0;
  for (const m of (text ?? "").matchAll(/\{\{\s*(\d{1,2})\s*\}\}/g)) max = Math.max(max, Number(m[1]));
  return max;
}

/**
 * The variables of a template text, in the order they are sent: positional
 * templates ({{1}}, {{2}}…) list "1".."n" up to the highest number; named
 * templates ({{first_name}}) list the names in first-use order.
 */
export function placeholderKeys(text: string | undefined): string[] {
  const found = [...(text ?? "").matchAll(PLACEHOLDER)].map((m) => m[1]);
  if (!found.length) return [];
  if (found.every((k) => /^\d{1,2}$/.test(k))) return Array.from({ length: placeholderCount(text) }, (_, i) => String(i + 1));
  return [...new Set(found.filter((k) => !/^\d+$/.test(k)))];
}

export interface TemplateVariables {
  /** Header format: TEXT, IMAGE, VIDEO, DOCUMENT, LOCATION, or null without a header. */
  headerFormat: string | null;
  header: string[];
  body: string[];
  /** NAMED when the template uses named variables (sent with parameter_name). */
  parameterFormat: "POSITIONAL" | "NAMED";
}

export function templateVariables(components: TemplateComponent[]): TemplateVariables {
  const header = components.find((c) => c.type?.toUpperCase() === "HEADER");
  const body = components.find((c) => c.type?.toUpperCase() === "BODY");
  const headerFormat = header ? (header.format ?? "TEXT").toUpperCase() : null;
  const h = headerFormat === "TEXT" ? placeholderKeys(header?.text) : [];
  const b = placeholderKeys(body?.text);
  const named = [...h, ...b].some((k) => !/^\d+$/.test(k));
  return { headerFormat, header: h, body: b, parameterFormat: named ? "NAMED" : "POSITIONAL" };
}

export function templateParams(components: TemplateComponent[]): { body: number; header: number } {
  const v = templateVariables(components);
  return { body: v.body.length, header: v.header.length };
}

/** A template text with its variables filled in ({{1}} → values[0], {{name}} → the value at that key's index). */
export function renderTemplateText(text: string, keys: string[], values: string[]): string {
  return text.replace(PLACEHOLDER, (whole, k: string) => {
    const i = keys.indexOf(k);
    return i >= 0 && values[i] !== undefined ? values[i] : whole;
  });
}

