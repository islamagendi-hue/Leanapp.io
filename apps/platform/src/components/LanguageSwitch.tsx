"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useLang } from "@/i18n/client";
import { LANG_NAMES } from "@/i18n/translate";

/** A link to the other language that comes back to this page (see /lang). */
export function LanguageSwitch({ className = "text-ink-2 hover:text-ink" }: { className?: string }) {
  const lang = useLang();
  const path = usePathname();
  const qs = useSearchParams().toString();
  const other = lang === "ar" ? "en" : "ar";
  const next = encodeURIComponent(qs ? `${path}?${qs}` : path);
  return (
    <a href={`/lang?to=${other}&next=${next}`} hrefLang={other} lang={other} className={className}>
      {LANG_NAMES[other]}
    </a>
  );
}
