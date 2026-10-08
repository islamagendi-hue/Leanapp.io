/**
 * The project Overview's choices that aren't plain reports. Pure.
 */
import type { GrowthDefinition } from "@/modules/growth/definition";

const START = /install|first_open|sign_?up|regist|account_created/i;

/**
 * The key funnel: where people start (an install or sign-up event the app
 * sends), then the Activation steps the project defined (activation, core
 * action, revenue), in that order and without repeats. Null when fewer than
 * two steps are known.
 */
export function keyFunnelSteps(def: GrowthDefinition | null | undefined, eventNames: string[]): string[] | null {
  const steps = [eventNames.find((n) => START.test(n)), def?.activation?.event, def?.core_action?.event, def?.revenue?.event]
    .filter((s): s is string => Boolean(s))
    .filter((s, i, all) => all.indexOf(s) === i)
    .slice(0, 4);
  return steps.length >= 2 ? steps : null;
}

export const OVERVIEW_RANGES = [7, 30] as const;
