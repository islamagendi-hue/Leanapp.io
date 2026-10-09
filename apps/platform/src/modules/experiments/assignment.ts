import "server-only";
import { z } from "zod";
import { withTenant } from "@/lib/db";
import { ValidationError } from "@/lib/errors";
import type { IngestionPrincipal } from "@/modules/credentials/service";
import { assign, personKey } from "./bucketing";
import type { Variant } from "./definition";

/**
 * GET/POST /v1/experiments/assignments: the variant of every running
 * experiment in the key's environment for one person (docs/sdk.md#experiments).
 *
 * The person is resolved like Analytics resolves people: the user_id; else
 * the one user the install is linked to; else the install. Assignment is a
 * hash (./bucketing.ts), so nothing is written here, and calling it never
 * counts as an exposure: the app sends `experiment_exposure` when it actually
 * shows a variant.
 *
 * Caveat (like in-app messages): a public key can't prove who the end user
 * is, so anyone with the key can ask for any id's variants. With an audience
 * target, whether a variant comes back reveals membership, so don't target
 * experiments on audiences that are sensitive.
 */
const subjectSchema = z
  .object({
    user_id: z.string().trim().max(200).optional().transform((v) => v || undefined),
    anonymous_id: z.string().trim().max(200).optional().transform((v) => v || undefined),
  })
  .refine((s) => s.user_id || s.anonymous_id, "Pass user_id, anonymous_id, or both.");

export interface AssignmentOut {
  experiment: string;
  experiment_id: string;
  /** Null when the person isn't in the experiment (outside its traffic or audience): show the default. */
  variant: string | null;
}

export async function assignmentsFor(principal: IngestionPrincipal, input: unknown): Promise<{ assignments: AssignmentOut[] }> {
  const parsed = subjectSchema.safeParse(input ?? {});
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid user.");
  const { user_id: userId, anonymous_id: anonymousId } = parsed.data;
  return withTenant({ organizationId: principal.organizationId, userId: null }, async (db) => {
    const linked = !userId && anonymousId
      ? (await db.one<{ user_id: string | null }>(
          `select min(user_id) as user_id from platform.identity_links where environment_id = $1 and anonymous_id = $2 having count(*) = 1`,
          [principal.environmentId, anonymousId],
        ))?.user_id ?? null
      : null;
    const person = personKey({ userId, anonymousId, linkedUserId: linked })!;
    const rows = await db.query<{ id: string; key: string; salt: string; variants: Variant[]; traffic_percent: number; in_audience: boolean }>(
      `select x.id, x.key, x.salt, x.variants, x.traffic_percent,
              (x.audience_id is null or exists (
                select 1 from platform.audience_members m where m.audience_id = x.audience_id and m.user_key = $2 and m.exited_at is null)) as in_audience
         from platform.experiments x
        where x.environment_id = $1 and x.status = 'running'
        order by x.key`,
      [principal.environmentId, person],
    );
    return {
      assignments: rows.map((r) => ({
        experiment: r.key,
        experiment_id: r.id,
        variant: assign({ salt: r.salt, variants: r.variants, trafficPercent: r.traffic_percent }, person, r.in_audience).variant?.key ?? null,
      })),
    };
  });
}
