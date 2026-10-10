/**
 * Messages with values in them (validation errors of audiences, automations
 * and campaigns) travel as plain English text, e.g. through ValidationError.
 * `fill` builds that text from a msg() template and remembers the template, so
 * `translateMessage` can recognise the text later and translate it with the
 * same values. Pure and client-safe.
 */
import { makeT, type Params, type T } from "@/i18n/translate";

const english = makeT(null);
const templates = new Map<string, { re: RegExp; names: string[] }>();
let ordered: [string, { re: RegExp; names: string[] }][] = [];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function remember(template: string) {
  if (templates.has(template) || !/\{\w+\}/.test(template)) return;
  const names: string[] = [];
  const source = template.split(/(\{\w+\})/).map((part) => {
    const m = /^\{(\w+)\}$/.exec(part);
    if (!m) return escape(part);
    names.push(m[1]);
    return "([\\s\\S]+?)";
  }).join("");
  templates.set(template, { re: new RegExp(`^${source}$`), names });
  // Most specific first: the longest fixed start (so "Step {n}: {message}" wins over "{property}: …"), then the most fixed text.
  const lead = (t: string) => t.search(/\{\w+\}|$/);
  const fixed = (t: string) => t.replace(/\{\w+\}/g, "").length;
  ordered = [...templates].sort((a, b) => lead(b[0]) - lead(a[0]) || fixed(b[0]) - fixed(a[0]));
}

/** Makes texts built elsewhere (e.g. stored run logs) recognisable by translateMessage. */
export function registerTemplates(list: readonly string[]) {
  list.forEach(remember);
}

/** The English text of `template` (marked with msg()) with `params` filled in. */
export function fill(template: string, params: Params): string {
  remember(template);
  return english(template, params);
}

/**
 * Translates a message that may have been built with `fill`: as a whole when
 * the dictionary has it, else by the template it came from (a `{message}`
 * value is itself translated, for prefixes like "Step 2: …"). Unknown text is
 * returned unchanged.
 */
export function translateMessage(t: T, text: string, depth = 0): string {
  const whole = t(text);
  if (whole !== text || depth > 3) return whole;
  for (const [template, { re, names }] of ordered) {
    const m = re.exec(text);
    if (!m) continue;
    const params: Params = {};
    names.forEach((n, i) => (params[n] = n === "message" ? translateMessage(t, m[i + 1], depth + 1) : m[i + 1]));
    return t(template, params);
  }
  return text;
}
