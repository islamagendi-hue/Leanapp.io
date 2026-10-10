import { getLang } from "@/i18n/server";
import type { Lang } from "@/i18n/translate";

export type Locale = Lang;
export type Direction = "ltr" | "rtl";

const DIRECTION: Record<Locale, Direction> = { en: "ltr", ar: "rtl" };

/** Maps a `locale` cookie value to a supported locale; anything else is English. */
export function resolveLocale(value: string | undefined | null): { lang: Locale; dir: Direction } {
  const lang: Locale = value?.trim().toLowerCase().startsWith("ar") ? "ar" : "en";
  return { lang, dir: DIRECTION[lang] };
}

/** `lang` and `dir` for <html>: the `locale` cookie, else the browser's preference (see pickLang). */
export async function getLocale(): Promise<{ lang: Locale; dir: Direction }> {
  return resolveLocale(await getLang());
}
