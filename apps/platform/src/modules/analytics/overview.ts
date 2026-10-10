/**
 * The project Overview's choices that aren't plain reports. Pure.
 */
import type { GrowthDefinition } from "@/modules/growth/definition";

const START = /install|first_open|sign_?up|regist|account_created/i;

/** The first install or sign-up looking event among the app's events (most used first). */
export function startEventOf(eventNames: string[]): string | null {
  return eventNames.find((n) => START.test(n)) ?? null;
}

/**
 * The key funnel: where people start (an install or sign-up event the app
 * sends), then the Activation steps the project defined (activation, core
 * action, revenue), in that order and without repeats. Null when fewer than
 * two steps are known.
 */
export function keyFunnelSteps(def: GrowthDefinition | null | undefined, eventNames: string[]): string[] | null {
  const steps = [startEventOf(eventNames), def?.activation?.event, def?.core_action?.event, def?.revenue?.event]
    .filter((s): s is string => Boolean(s))
    .filter((s, i, all) => all.indexOf(s) === i)
    .slice(0, 4);
  return steps.length >= 2 ? steps : null;
}

/** Events that happen all the time and say little as a funnel step. */
const BACKGROUND = /^(\$|app_opened$|app_open$|session_start|screen_view|app_backgrounded|app_foregrounded)/i;
const MIDDLE = /cart|checkout_start|add_to|added|view_item|product/i;
const END = /purchase|order_completed|checkout_completed|subscri|payment|paid/i;

/**
 * Steps for a funnel opened without any: start (install or sign-up), one step
 * in between and a conversion, picked from the app's events (most used
 * first). Empty when fewer than two distinct events would make sense.
 */
export function defaultFunnelSteps(eventNames: string[]): string[] {
  const start = startEventOf(eventNames) ?? eventNames.find((n) => !BACKGROUND.test(n)) ?? null;
  const rest = eventNames.filter((n) => n !== start && !BACKGROUND.test(n));
  const end = rest.find((n) => END.test(n)) ?? null;
  const others = rest.filter((n) => n !== end);
  const middle = others.find((n) => MIDDLE.test(n)) ?? others[0] ?? null;
  const steps = [start, middle, end].filter((s): s is string => Boolean(s));
  return steps.length >= 2 ? steps : [];
}

export const OVERVIEW_RANGES = [7, 30] as const;

const SIGNUP = /sign_?up|regist|account_created/i;
const INSTALL = /install|first_open/i;

/** The sign-up event the app sends (most used first), if any. */
export function signupEventOf(eventNames: string[]): string | null {
  return eventNames.find((n) => SIGNUP.test(n) && !INSTALL.test(n)) ?? null;
}

/** The order (conversion) event: the Activation revenue event when defined, else the first purchase-like event. */
export function orderEventOf(def: GrowthDefinition | null | undefined, eventNames: string[]): string | null {
  return def?.revenue?.event ?? eventNames.find((n) => END.test(n)) ?? null;
}

/**
 * The Overview's conversion funnel: install, sign up, one step in between
 * (add to cart and the like, else the Activation core action) and the order,
 * from the events the app sends, in that order and without repeats. Falls
 * back to the key funnel; null when fewer than two steps are known.
 */
export function overviewFunnelSteps(def: GrowthDefinition | null | undefined, eventNames: string[]): string[] | null {
  const install = eventNames.find((n) => INSTALL.test(n)) ?? null;
  const signup = signupEventOf(eventNames);
  const order = orderEventOf(def, eventNames);
  const middle = eventNames.find((n) => MIDDLE.test(n) && n !== order) ?? def?.core_action?.event ?? null;
  const steps = [install, signup, middle, order]
    .filter((s): s is string => Boolean(s))
    .filter((s, i, all) => all.indexOf(s) === i);
  return steps.length >= 2 ? steps : keyFunnelSteps(def, eventNames);
}
