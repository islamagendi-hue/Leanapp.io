import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { AR } from "./ar";
import { makeT, pickLang, type Lang, type T } from "./translate";

/** This request's language (cookie, then browser preference). */
export const getLang = cache(async (): Promise<Lang> => {
  const [store, h] = await Promise.all([cookies(), headers()]);
  return pickLang(store.get("locale")?.value, h.get("accept-language"));
});

/** The translate function for this request, for server components and actions. */
export const getT = cache(async (): Promise<T> => makeT((await getLang()) === "ar" ? AR : null));

/** The dictionary client components need (none in English). */
export async function clientDictionary(): Promise<Record<string, string> | null> {
  return (await getLang()) === "ar" ? AR : null;
}
