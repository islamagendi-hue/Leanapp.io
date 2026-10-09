"use client";

import { createContext, useContext, useMemo } from "react";
import { makeT, type Lang, type T } from "./translate";

const Ctx = createContext<{ lang: Lang; t: T }>({ lang: "en", t: makeT(null) });

/** Gives client components the request's language (set once in the root layout). */
export function I18nProvider({ lang, dict, children }: { lang: Lang; dict: Record<string, string> | null; children: React.ReactNode }) {
  const value = useMemo(() => ({ lang, t: makeT(dict) }), [lang, dict]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useT = () => useContext(Ctx).t;
export const useLang = () => useContext(Ctx).lang;
