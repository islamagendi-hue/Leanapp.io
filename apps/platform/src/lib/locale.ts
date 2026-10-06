import { cookies } from "next/headers";

export type Locale = "en" | "ar";
export type Direction = "ltr" | "rtl";

const DIRECTION: Record<Locale, Direction> = { en: "ltr", ar: "rtl" };

/** Maps a `locale` cookie value to a supported locale; anything else is English. */
export function resolveLocale(value: string | undefined | null): { lang: Locale; dir: Direction } {
  const lang: Locale = value?.trim().toLowerCase().startsWith("ar") ? "ar" : "en";
  return { lang, dir: DIRECTION[lang] };
}

/**
 * `lang` and `dir` for <html>. The UI strings are English only for now: an `ar`
 * locale cookie switches the document to Arabic/RTL so layouts (which use logical
 * utilities like ms-, pe-, text-start) can be checked, but nothing is translated yet.
 */
export async function getLocale(): Promise<{ lang: Locale; dir: Direction }> {
  const store = await cookies();
  return resolveLocale(store.get("locale")?.value);
}
