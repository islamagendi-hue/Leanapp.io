/**
 * The UI's two languages. Strings are written in English in the code and
 * looked up by that English text in the Arabic dictionaries (src/i18n/ar),
 * so anything not translated yet still reads correctly in English.
 * `{name}` placeholders are filled from `params`. Pure.
 */
export type Lang = "en" | "ar";
export type Params = Record<string, string | number>;
export type T = (text: string, params?: Params) => string;

export const LANGS: Lang[] = ["en", "ar"];
export const LANG_NAMES: Record<Lang, string> = { en: "English", ar: "العربية" };

function fill(text: string, params?: Params): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

export function makeT(dict: Record<string, string> | null): T {
  return (text, params) => fill((dict && dict[text]) || text, params);
}

/** Formats a number the same way in both languages (Latin digits, which apps in the region use). */
export const fmtNumber = (n: number, opts?: Intl.NumberFormatOptions) => n.toLocaleString("en-US", opts);

/** Date formatting with Arabic month names and Latin digits in Arabic. */
export function dateLocale(lang: Lang): string {
  return lang === "ar" ? "ar-EG-u-nu-latn-ca-gregory" : "en-GB";
}

/**
 * The language to use: the `locale` cookie when it names one, otherwise the
 * browser's first preference. Arabic is the default (the Arab market comes
 * first); a browser that prefers another language gets English.
 */
export function pickLang(cookie: string | undefined | null, acceptLanguage: string | null | undefined): Lang {
  const c = cookie?.trim().toLowerCase();
  if (c?.startsWith("ar")) return "ar";
  if (c?.startsWith("en")) return "en";
  const first = acceptLanguage?.split(",")[0]?.trim().toLowerCase() ?? "";
  return first === "" || first.startsWith("ar") ? "ar" : "en";
}

/**
 * Marks English text that is translated later, where it's rendered (menu
 * labels, option lists and messages built outside components). Returns it
 * unchanged; i18n.test.ts checks the Arabic dictionary has it.
 */
export const msg = (text: string) => text;
