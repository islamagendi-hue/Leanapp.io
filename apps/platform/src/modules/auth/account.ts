import "server-only";
import { z } from "zod";
import { hashPassword, randomToken, sha256, verifyPassword } from "@/lib/crypto";
import { withSystem, type Db } from "@/lib/db";
import { RateLimitError, UnauthorizedError, ValidationError } from "@/lib/errors";
import { consumeRateLimit } from "@/lib/rate-limit";
import { safeNext } from "@/lib/safe-next";
import { audit } from "@/modules/audit/service";
import { sendEmail, type SendResult } from "@/modules/email/service";
import { passwordChangedMessage, passwordResetMessage, verifyEmailMessage } from "@/modules/email/templates";
import { publicAppUrl } from "@/server/env";
import { newPasswordSchema, parse, revokeAllSessions } from "./service";

/**
 * Account lifecycle flows that need one-time tokens: email verification and
 * password reset, plus password change. Tokens are random, stored as SHA-256,
 * single-use and short-lived; issuing a new token invalidates older ones.
 */
const TTL = { verify_email: 24 * 3600, reset_password: 3600 } as const;
type Purpose = keyof typeof TTL;

async function issueToken(db: Db, userId: string, email: string, purpose: Purpose): Promise<string> {
  await db.query("update platform.auth_tokens set used_at = now() where user_id = $1 and purpose = $2 and used_at is null", [userId, purpose]);
  const token = randomToken(32);
  await db.query(
    "insert into platform.auth_tokens (user_id, purpose, token_hash, email, expires_at) values ($1, $2, $3, $4, now() + make_interval(secs => $5))",
    [userId, purpose, sha256(token), email, TTL[purpose]],
  );
  return token;
}

/** Marks a token used and returns its user, or null when it is unknown, used or expired. */
async function consumeToken(db: Db, token: string, purpose: Purpose): Promise<{ user_id: string; email: string } | null> {
  if (!token || token.length > 200) return null;
  return db.one<{ user_id: string; email: string }>(
    `update platform.auth_tokens set used_at = now()
      where token_hash = $1 and purpose = $2 and used_at is null and expires_at > now()
      returning user_id, email`,
    [sha256(token), purpose],
  );
}

// ── Email verification ──────────────────────────────────────────────────────
/** `next` (a safe relative path, e.g. an invitation) is carried on the link so confirming returns the user there. */
export async function sendVerificationEmail(userId: string, opts: { next?: string | null } = {}): Promise<SendResult | { delivered: false; transport: "skipped" }> {
  if (await consumeRateLimit(`verify-email:${userId}`, 5, 3600)) throw new RateLimitError(3600);
  const issued = await withSystem(async (db) => {
    const u = await db.one<{ email: string; name: string; email_verified_at: Date | null }>(
      "select email, name, email_verified_at from platform.users where id = $1 and status = 'active'",
      [userId],
    );
    if (!u || u.email_verified_at) return null;
    return { ...u, token: await issueToken(db, userId, u.email, "verify_email") };
  });
  if (!issued) return { delivered: false, transport: "skipped" };
  const next = safeNext(opts.next);
  const link = `${publicAppUrl()}/verify-email/${issued.token}${next ? `?next=${encodeURIComponent(next)}` : ""}`;
  return sendEmail(verifyEmailMessage(issued.email, issued.name, link));
}

/** Verifies the address the token was sent to. Fails if the account's email changed since. */
export async function verifyEmail(token: string): Promise<{ userId: string } | null> {
  return withSystem(async (db) => {
    const t = await consumeToken(db, token, "verify_email");
    if (!t) return null;
    const row = await db.one<{ id: string }>(
      "update platform.users set email_verified_at = coalesce(email_verified_at, now()) where id = $1 and lower(email) = lower($2) returning id",
      [t.user_id, t.email],
    );
    if (!row) return null;
    await audit(db, { organizationId: null, actorUserId: row.id, action: "auth.email_verified" });
    return { userId: row.id };
  });
}

// ── Password reset ──────────────────────────────────────────────────────────
const resetRequestSchema = z.object({ email: z.string().trim().toLowerCase().email("Enter a valid email.").max(200) });

/**
 * Always resolves the same way whether or not the account exists, so the form
 * can't be used to discover registered emails. Throttled per email and per IP.
 */
export async function requestPasswordReset(input: unknown, meta: { ip?: string } = {}): Promise<void> {
  const { email } = parse(resetRequestSchema, input);
  const wait = Math.max(await consumeRateLimit(`reset:email:${email}`, 3, 3600), await consumeRateLimit(`reset:ip:${meta.ip ?? "unknown"}`, 20, 3600));
  if (wait) throw new RateLimitError(wait);
  const issued = await withSystem(async (db) => {
    const u = await db.one<{ id: string; email: string; name: string }>(
      "select id, email, name from platform.users where lower(email) = $1 and status = 'active' and password_hash is not null",
      [email],
    );
    if (!u) return null;
    const token = await issueToken(db, u.id, u.email, "reset_password");
    await audit(db, { organizationId: null, actorUserId: u.id, action: "auth.password_reset_requested", metadata: { ip: meta.ip ?? null } });
    return { ...u, token };
  });
  if (issued) await sendEmail(passwordResetMessage(issued.email, issued.name, `${publicAppUrl()}/reset-password/${issued.token}`));
}

/** True when a reset token is still usable; lets the page show "link expired" before the user types a password. */
export async function isResetTokenValid(token: string): Promise<boolean> {
  if (!token || token.length > 200) return false;
  const row = await withSystem((db) =>
    db.one("select 1 from platform.auth_tokens where token_hash = $1 and purpose = 'reset_password' and used_at is null and expires_at > now()", [sha256(token)]),
  );
  return !!row;
}

/** Sets a new password, signs out every session and confirms by email. Reset also proves the email address. */
export async function resetPassword(token: string, newPassword: unknown): Promise<void> {
  const password = parse(newPasswordSchema, newPassword);
  const hash = await hashPassword(password);
  const user = await withSystem(async (db) => {
    const t = await consumeToken(db, token, "reset_password");
    if (!t) throw new ValidationError("This reset link is invalid or has expired. Ask for a new one.");
    const u = await db.one<{ id: string; email: string; name: string }>(
      `update platform.users set password_hash = $2, email_verified_at = coalesce(email_verified_at, now())
        where id = $1 and lower(email) = lower($3) and status = 'active' returning id, email, name`,
      [t.user_id, hash, t.email],
    );
    if (!u) throw new ValidationError("This reset link is invalid or has expired. Ask for a new one.");
    await db.query("update platform.auth_sessions set revoked_at = now() where user_id = $1 and revoked_at is null", [u.id]);
    await audit(db, { organizationId: null, actorUserId: u.id, action: "auth.password_reset" });
    return u;
  });
  await sendEmail(passwordChangedMessage(user.email, user.name));
}

// ── Signed-in account management ────────────────────────────────────────────
const changePasswordSchema = z.object({ currentPassword: z.string().min(1, "Enter your current password.").max(200), newPassword: newPasswordSchema });

/** Changes the password after re-checking the current one; other sessions are signed out, the current one stays. */
export async function changePassword(userId: string, input: unknown, currentSessionToken: string | null): Promise<void> {
  const data = parse(changePasswordSchema, input);
  if (await consumeRateLimit(`change-password:${userId}`, 10, 900)) throw new RateLimitError(900);
  const u = await withSystem((db) =>
    db.one<{ email: string; name: string; password_hash: string | null }>("select email, name, password_hash from platform.users where id = $1", [userId]),
  );
  if (!u?.password_hash || !(await verifyPassword(data.currentPassword, u.password_hash))) {
    throw new UnauthorizedError("Current password is incorrect.");
  }
  if (data.currentPassword === data.newPassword) throw new ValidationError("Choose a password you haven't used here.");
  const hash = await hashPassword(data.newPassword);
  await withSystem(async (db) => {
    await db.query("update platform.users set password_hash = $2 where id = $1", [userId, hash]);
    await audit(db, { organizationId: null, actorUserId: userId, action: "auth.password_changed" });
  });
  await revokeAllSessions(userId, currentSessionToken);
  await sendEmail(passwordChangedMessage(u.email, u.name));
}

const profileSchema = z.object({ name: z.string().trim().min(2, "Enter your name.").max(120) });

/** Changes the name shown to teammates (members list, audit log, emails). */
export async function updateProfile(userId: string, input: unknown): Promise<void> {
  const data = parse(profileSchema, input);
  await withSystem(async (db) => {
    await db.query("update platform.users set name = $2 where id = $1", [userId, data.name]);
    await audit(db, { organizationId: null, actorUserId: userId, action: "auth.profile_updated" });
  });
}

/** "Sign out everywhere else". Returns how many sessions were ended. */
export async function signOutOtherSessions(userId: string, currentSessionToken: string | null): Promise<number> {
  const n = await revokeAllSessions(userId, currentSessionToken);
  await withSystem((db) => audit(db, { organizationId: null, actorUserId: userId, action: "auth.sessions_revoked", metadata: { count: n } }));
  return n;
}

export interface ActiveSession {
  id: string;
  user_agent: string | null;
  created_at: Date;
  last_seen_at: Date;
  current: boolean;
}

export async function listSessions(userId: string, currentSessionToken: string | null): Promise<ActiveSession[]> {
  const rows = await withSystem((db) =>
    db.query<{ id: string; user_agent: string | null; created_at: Date; last_seen_at: Date; token_hash: string }>(
      `select id, user_agent, created_at, last_seen_at, token_hash from platform.auth_sessions
        where user_id = $1 and revoked_at is null and expires_at > now() order by last_seen_at desc limit 50`,
      [userId],
    ),
  );
  const current = currentSessionToken ? sha256(currentSessionToken) : null;
  return rows.map(({ token_hash, ...r }) => ({ ...r, current: token_hash === current }));
}
