import "server-only";
import { withSystem, type Db } from "@/lib/db";
import { sha256 } from "@/lib/crypto";

/**
 * Privacy tombstones: what a completed deletion leaves behind so the deleted
 * person is not re-created by events still in an SDK's offline queue or sent
 * later by a backend.
 *
 * One row per identifier the deletion removed, in platform.privacy_tombstones:
 * - kind `user_id`: the deleted user id. Ingestion drops every event carrying it.
 * - kind `anonymous_id`: each install whose anonymous activity was deleted.
 *   Ingestion drops that install's anonymous events (no user_id), mirroring
 *   what the deletion removed: another user's identified events on the same
 *   install were never the subject's and are still accepted. Shared installs
 *   (skipped by the deletion) get no tombstone.
 *
 * Only a hash of the identifier is stored (see tombstoneHash). Tombstones
 * never expire; a person who comes back is a new user with a new user_id.
 */

export type TombstoneKind = "user_id" | "anonymous_id";

/**
 * sha256 of the identifier, scoped to the environment and the kind. Not keyed
 * with a server secret on purpose: losing or rotating a secret would silently
 * turn every tombstone off, and the deletion request row (privacy_requests)
 * keeps the subject's ids anyway as the record of the request. The hash keeps
 * the tombstone itself from carrying the id, and makes the same id unrelated
 * across environments and organizations.
 */
export function tombstoneHash(environmentId: string, kind: TombstoneKind, id: string): string {
  return sha256(`privacy-tombstone:v1:${environmentId}:${kind}:${id}`);
}

const LOCK_KEY = "hashtextextended('platform.privacy.tombstones:' || $1, 0)";

/**
 * Ingestion takes this lock (shared) before reading tombstones, and holds it
 * until its transaction ends. See waitForIngestion.
 */
export async function lockTombstonesShared(db: Db, environmentId: string): Promise<void> {
  await db.query(`select pg_advisory_xact_lock_shared(${LOCK_KEY})`, [environmentId]);
}

/**
 * Waits until every ingestion transaction of the environment that might have
 * read the tombstones before they were committed has finished. After it
 * returns, an ingestion either committed already (its events are visible to the
 * deletion that follows) or reads the committed tombstones. The exclusive lock
 * is held only for an instant.
 */
export async function waitForIngestion(environmentId: string): Promise<void> {
  await withSystem((db) => db.query(`select pg_advisory_xact_lock(${LOCK_KEY})`, [environmentId]));
}

export async function writeTombstones(
  db: Db,
  t: { organizationId: string; environmentId: string; privacyRequestId: string; userIds: string[]; anonymousIds: string[] },
): Promise<number> {
  const rows = [
    ...t.userIds.map((id) => ["user_id", tombstoneHash(t.environmentId, "user_id", id)]),
    ...t.anonymousIds.map((id) => ["anonymous_id", tombstoneHash(t.environmentId, "anonymous_id", id)]),
  ];
  if (!rows.length) return 0;
  const inserted = await db.query(
    `insert into platform.privacy_tombstones (organization_id, environment_id, kind, subject_hash, privacy_request_id)
     select $1, $2, r.kind, r.hash, $3 from unnest($4::text[], $5::text[]) as r(kind, hash)
     on conflict (environment_id, kind, subject_hash) do nothing
     returning 1`,
    [t.organizationId, t.environmentId, t.privacyRequestId, rows.map((r) => r[0]), rows.map((r) => r[1])],
  );
  return inserted.length;
}

/**
 * Which of these events belong to a deleted subject: one primary-key lookup
 * for the whole batch. Returns a predicate over the same events.
 */
export async function deletedSubjectFilter(
  db: Db,
  environmentId: string,
  events: { user_id: string | null; anonymous_id: string | null }[],
): Promise<(e: { user_id: string | null; anonymous_id: string | null }) => boolean> {
  const userHash = (id: string) => tombstoneHash(environmentId, "user_id", id);
  const anonHash = (id: string) => tombstoneHash(environmentId, "anonymous_id", id);
  const users = [...new Set(events.flatMap((e) => (e.user_id ? [userHash(e.user_id)] : [])))];
  const anons = [...new Set(events.flatMap((e) => (!e.user_id && e.anonymous_id ? [anonHash(e.anonymous_id)] : [])))];
  if (!users.length && !anons.length) return () => false;
  const rows = await db.query<{ kind: TombstoneKind; subject_hash: string }>(
    `select kind, subject_hash from platform.privacy_tombstones
      where environment_id = $1
        and ((kind = 'user_id' and subject_hash = any($2)) or (kind = 'anonymous_id' and subject_hash = any($3)))`,
    [environmentId, users, anons],
  );
  if (!rows.length) return () => false;
  const hit = new Set(rows.map((r) => `${r.kind}:${r.subject_hash}`));
  return (e) =>
    e.user_id ? hit.has(`user_id:${userHash(e.user_id)}`) : !!e.anonymous_id && hit.has(`anonymous_id:${anonHash(e.anonymous_id)}`);
}
