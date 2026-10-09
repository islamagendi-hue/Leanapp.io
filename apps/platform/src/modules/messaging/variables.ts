/**
 * Template variable mapping, shared by the composer (client) and the server
 * checks. A template variable ({{1}} or {{first_name}}) is filled from a user
 * attribute ({{user.x}}), a trigger event property ({{event.x}}) or fixed
 * text. Pure and client-safe.
 */
import { renderTemplateText } from "@/modules/whatsapp/template-text";

export type VariableSource = { kind: "user" | "event" | "text"; value: string };

const REF = /^\{\{\s*(user|event)\.([A-Za-z0-9_.$-]{1,64})\s*\}\}$/;

export function toParam(s: VariableSource): string {
  const v = s.value.trim();
  if (s.kind === "text") return v;
  return v ? `{{${s.kind}.${v}}}` : "";
}

export function fromParam(p: string): VariableSource {
  const m = REF.exec(p.trim());
  return m ? { kind: m[1] as "user" | "event", value: m[2] } : { kind: "text", value: p };
}

/** 1-based positions of variables left empty (every variable is required by WhatsApp). */
export function missingVariables(keys: readonly string[], params: readonly string[]): number[] {
  return keys.flatMap((_, i) => ((params[i] ?? "").trim() ? [] : [i + 1]));
}

/** Fills {{user.x}} / {{event.x}} from sample values (unknown → shown as the reference itself, so the preview says what's missing). */
export function resolveSample(param: string, sample: { user?: Record<string, unknown>; event?: Record<string, unknown> }): string {
  return param.replace(/\{\{\s*(user|event)\.([A-Za-z0-9_.$-]{1,64})\s*\}\}/g, (whole, scope: "user" | "event", key: string) => {
    const v = sample[scope]?.[key];
    return v === null || v === undefined || typeof v === "object" ? whole : String(v);
  });
}

/** The template text as the person would see it, with each variable replaced by its mapped (sample) value. */
export function previewTemplate(text: string, keys: readonly string[], params: readonly string[], sample: { user?: Record<string, unknown>; event?: Record<string, unknown> } = {}): string {
  return renderTemplateText(text, [...keys], keys.map((k, i) => ((params[i] ?? "").trim() ? resolveSample(params[i], sample) : `{{${k}}}`)));
}

/** GSM-7 or UCS-2 SMS segments for a text (Arabic and emoji need UCS-2: 70 characters, 67 per part). */
export function smsSegments(text: string): { encoding: "GSM-7" | "UCS-2"; segments: number; characters: number } {
  const gsm = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\[~\]|€]*$/.test(text);
  const characters = gsm ? [...text].reduce((n, c) => n + ("^{}\\[~]|€".includes(c) ? 2 : 1), 0) : [...text].length;
  const [single, multi] = gsm ? [160, 153] : [70, 67];
  return { encoding: gsm ? "GSM-7" : "UCS-2", segments: characters <= single ? (characters ? 1 : 0) : Math.ceil(characters / multi), characters };
}
