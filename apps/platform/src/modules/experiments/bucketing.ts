/**
 * Deterministic, sticky assignment. Nothing is stored: a person's variant is a
 * hash of the experiment's salt and the person's key, so every call (any
 * server, any time) gives the same answer while the experiment runs.
 *
 * Two independent hashes are used: one decides whether the person is in the
 * experiment's traffic, the other picks the variant. Variants are picked by
 * their weights. Pure (node:crypto only).
 */
import { createHash } from "node:crypto";

export interface WeightedVariant {
  key: string;
  weight: number;
}

/** A number in [0, 1) from the first 52 bits of sha256(salt:purpose:person). */
export function unitHash(salt: string, purpose: string, person: string): number {
  const hex = createHash("sha256").update(`${salt}:${purpose}:${person}`).digest("hex").slice(0, 13);
  return parseInt(hex, 16) / 2 ** 52;
}

/** The variant for a unit value in [0, 1), by cumulative weight. */
export function pickByWeight<V extends WeightedVariant>(variants: V[], u: number): V {
  const total = variants.reduce((a, v) => a + Math.max(0, v.weight), 0);
  let edge = 0;
  for (const v of variants) {
    edge += Math.max(0, v.weight) / total;
    if (u < edge) return v;
  }
  return variants[variants.length - 1];
}

export type Assignment<V> = { variant: V; reason: "assigned" } | { variant: null; reason: "not_in_audience" | "outside_traffic" };

/**
 * The variant for one person, or why they are not in the experiment.
 * `inAudience` is false only when the experiment targets an audience the person isn't in.
 */
export function assign<V extends WeightedVariant>(e: { salt: string; variants: V[]; trafficPercent: number }, person: string, inAudience = true): Assignment<V> {
  if (!inAudience) return { variant: null, reason: "not_in_audience" };
  if (unitHash(e.salt, "traffic", person) * 100 >= e.trafficPercent) return { variant: null, reason: "outside_traffic" };
  return { variant: pickByWeight(e.variants, unitHash(e.salt, "variant", person)), reason: "assigned" };
}

/**
 * The person an assignment is for, by the analytics people rule: the user_id;
 * else the one user the install is linked to; else the install (`anon:<id>`).
 */
export function personKey(input: { userId?: string | null; anonymousId?: string | null; linkedUserId?: string | null }): string | null {
  if (input.userId) return input.userId;
  if (input.linkedUserId) return input.linkedUserId;
  return input.anonymousId ? `anon:${input.anonymousId}` : null;
}
