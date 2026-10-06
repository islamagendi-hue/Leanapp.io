import "server-only";
import { z } from "zod";
import { withTenant } from "@/lib/db";
import { NotFoundError, ValidationError } from "@/lib/errors";
import type { IngestionPrincipal } from "@/modules/credentials/service";

/**
 * In-app messages for the SDK. The app polls with its public SDK key, which
 * fixes organization and environment; rows are read under that
 * organization's RLS scope and filtered to the key's environment.
 *
 * Caveat (documented in docs/sdk.md): a public key can't prove who the end
 * user is, so anyone holding the app's key and a user's id could read that
 * user's pending messages. Don't put secrets or sensitive personal data in
 * in-app messages.
 */
const subjectSchema = z
  .object({
    userId: z.string().trim().max(256).optional().transform((v) => v || undefined),
    anonymousId: z.string().trim().max(256).optional().transform((v) => v || undefined),
  })
  .refine((s) => s.userId || s.anonymousId, "Pass user_id, anonymous_id, or both.");

function userKeys(input: unknown): string[] {
  const r = subjectSchema.safeParse(input);
  if (!r.success) throw new ValidationError(r.error.issues[0]?.message ?? "Invalid user.");
  return [...(r.data.userId ? [r.data.userId] : []), ...(r.data.anonymousId ? [`anon:${r.data.anonymousId}`] : [])];
}

export interface InAppMessage {
  id: string;
  title: string;
  body: string;
  button_text: string | null;
  deep_link: string | null;
  data: Record<string, unknown>;
  created_at: Date;
  expires_at: Date;
}

const scope = (p: IngestionPrincipal) => ({ organizationId: p.organizationId, userId: null });

/** Messages to show now (pending or shown but not acted on), newest first, at most 10. */
export async function pendingInAppMessages(principal: IngestionPrincipal, input: unknown): Promise<InAppMessage[]> {
  const keys = userKeys(input);
  return withTenant(scope(principal), (db) =>
    db.query<InAppMessage>(
      `select id, title, body, button_text, deep_link, data, created_at, expires_at
         from platform.in_app_messages
        where environment_id = $1 and user_key = any($2) and status in ('pending', 'displayed') and expires_at > now()
        order by created_at desc limit 10`,
      [principal.environmentId, keys],
    ),
  );
}

export const IN_APP_ACTIONS = { impression: "displayed", click: "clicked", dismiss: "dismissed" } as const;

/** Records that a message was shown, clicked or dismissed. Only for a message addressed to the given user in the key's environment. */
export async function recordInAppAction(principal: IngestionPrincipal, id: string, input: { action?: unknown; userId?: unknown; anonymousId?: unknown }): Promise<{ status: string }> {
  if (!z.string().uuid().safeParse(id).success) throw new NotFoundError("Message");
  const action = input.action as keyof typeof IN_APP_ACTIONS;
  if (!Object.hasOwn(IN_APP_ACTIONS, action)) throw new ValidationError('action must be "impression", "click" or "dismiss".');
  const keys = userKeys({ userId: input.userId, anonymousId: input.anonymousId });
  const status = IN_APP_ACTIONS[action];
  const row = await withTenant(scope(principal), (db) =>
    db.one<{ status: string }>(
      `update platform.in_app_messages
          set status = case when status in ('clicked', 'dismissed') then status else $4 end,
              displayed_at = coalesce(displayed_at, now()),
              clicked_at = case when $4 = 'clicked' then coalesce(clicked_at, now()) else clicked_at end,
              dismissed_at = case when $4 = 'dismissed' then coalesce(dismissed_at, now()) else dismissed_at end
        where id = $1 and environment_id = $2 and user_key = any($3)
        returning status`,
      [id, principal.environmentId, keys, status],
    ),
  );
  if (!row) throw new NotFoundError("Message");
  return row;
}
