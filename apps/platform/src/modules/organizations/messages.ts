import { makeT, type Params } from "@/i18n/translate";

/**
 * Errors whose message has values in it (an email, a limit) can't be looked up
 * by their English text. These helpers keep the untranslated template and its
 * values on the error, so a server action can translate the whole sentence.
 */
const english = makeT(null);
const PARAMS = Symbol.for("leanapp.messageParams");

type Templated = { [PARAMS]?: { template: string; params: Params } };

/** Builds an error from `template` (marked with msg()) filled with `params`, remembering both. */
export function withParams<E extends Error>(make: (message: string) => E, template: string, params: Params): E {
  const e = make(english(template, params)) as E & Templated;
  e[PARAMS] = { template, params };
  return e;
}

/** The template and values of an error made by withParams, if it was. */
export function messageParams(err: unknown): { template: string; params: Params } | undefined {
  return err && typeof err === "object" ? (err as Templated)[PARAMS] : undefined;
}
