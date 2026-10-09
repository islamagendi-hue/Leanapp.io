import { makeT, type T } from "@/i18n/translate";

/** Fills an English message template (`{name}` placeholders), as the modules throw it. */
export const en: T = makeT(null);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Translates a message a module built from known English templates (marked
 * with msg() where they're defined), even when several were joined into one
 * string. Text that matches no template stays as it is. Pure.
 */
export function localize(message: string, t: T, templates: readonly string[]): string {
  let out = message;
  for (const tpl of templates) {
    const names: string[] = [];
    const source = escape(tpl).replace(/\\\{(\w+)\\\}/g, (_, n: string) => {
      names.push(n);
      return "(.+?)";
    });
    out = out.replace(new RegExp(source, "g"), (...m: string[]) => t(tpl, Object.fromEntries(names.map((n, i) => [n, m[i + 1]]))));
  }
  return out;
}
