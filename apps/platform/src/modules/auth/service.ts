import "server-only";
import { z } from "zod";
import { DUMMY_PASSWORD_HASH, hashPassword, randomToken, sha256, verifyPassword } from "@/lib/crypto";
import { isUniqueViolation, withSystem } from "@/lib/db";
import { ConflictError, RateLimitError, UnauthorizedError, ValidationError } from "@/lib/errors";
import { consumeRateLimit } from "@/lib/rate-limit";
import { audit } from "@/modules/audit/service";

export const SESSION_TTL_DAYS = 30;

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  isPlatformAdmin: boolean;
}

export const signUpSchema = z.object({
  name: z.string().trim().min(2, "Enter your name.").max(120),
  email: z.string().trim().toLowerCase().email("Enter a valid email.").max(200),
  password: z
    .string()
    .min(10, "Use at least 10 characters.")
    .max(200)
    .refine((p) => /[a-zA-Z]/.test(p) && /[0-9]/.test(p), "Use letters and at least one number."),
});

export const signInSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email.").max(200),
  password: z.string().min(1, "Enter your password.").max(200),
});

export interface SessionResult {
  user: AuthUser;
  token: string;
  expiresAt: Date;
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new ValidationError(r.error.issues[0]?.message ?? "Invalid input.", z.flattenError(r.error).fieldErrors);
  return r.data;
}

async function createSession(userId: string, userAgent: string | null) {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000);
  await withSystem((db) =>
    db.query("insert into platform.auth_sessions (user_id, token_hash, expires_at, user_agent) values ($1, $2, $3, $4)", [
      userId,
      sha256(token),
      expiresAt,
      userAgent?.slice(0, 300) ?? null,
    ]),
  );
  return { token, expiresAt };
}

export async function signUp(input: unknown, meta: { userAgent?: string | null; ip?: string } = {}): Promise<SessionResult> {
  const data = parse(signUpSchema, input);
  if (await consumeRateLimit(`signup:${meta.ip ?? "unknown"}`, 10, 3600)) throw new RateLimitError(3600);
  const passwordHash = await hashPassword(data.password);
  let user: AuthUser;
  try {
    user = await withSystem(async (db) => {
      const row = await db.one<{ id: string }>(
        "insert into platform.users (email, name, password_hash) values ($1, $2, $3) returning id",
        [data.email, data.name, passwordHash],
      );
      await audit(db, { organizationId: null, actorUserId: row!.id, action: "auth.signup" });
      return { id: row!.id, email: data.email, name: data.name, isPlatformAdmin: false };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError("An account with this email already exists. Sign in instead.");
    throw err;
  }
  const session = await createSession(user.id, meta.userAgent ?? null);
  return { user, ...session };
}

export async function signIn(input: unknown, meta: { userAgent?: string | null; ip?: string } = {}): Promise<SessionResult> {
  const data = parse(signInSchema, input);
  // Throttle per account and per IP to blunt credential stuffing.
  const wait = Math.max(
    await consumeRateLimit(`login:email:${data.email}`, 10, 900),
    await consumeRateLimit(`login:ip:${meta.ip ?? "unknown"}`, 50, 900),
  );
  if (wait) throw new RateLimitError(wait);

  const row = await withSystem((db) =>
    db.one<{ id: string; email: string; name: string; password_hash: string | null; status: string; is_platform_admin: boolean }>(
      "select id, email, name, password_hash, status, is_platform_admin from platform.users where lower(email) = $1",
      [data.email],
    ),
  );
  const ok = await verifyPassword(data.password, row?.password_hash ?? DUMMY_PASSWORD_HASH);
  if (!row || !row.password_hash || !ok || row.status !== "active") {
    if (row) await withSystem((db) => audit(db, { organizationId: null, actorUserId: row.id, action: "auth.login_failed" }));
    throw new UnauthorizedError("Email or password is incorrect.");
  }
  await withSystem(async (db) => {
    await db.query("update platform.users set last_login_at = now() where id = $1", [row.id]);
    await audit(db, { organizationId: null, actorUserId: row.id, action: "auth.login" });
  });
  const session = await createSession(row.id, meta.userAgent ?? null);
  return { user: { id: row.id, email: row.email, name: row.name, isPlatformAdmin: row.is_platform_admin }, ...session };
}

/** Resolves a session cookie token to its user. Returns null if missing, expired or revoked. */
export async function getUserBySessionToken(token: string | undefined | null): Promise<AuthUser | null> {
  if (!token || token.length > 200) return null;
  const row = await withSystem((db) =>
    db.one<{ id: string; email: string; name: string; is_platform_admin: boolean; session_id: string; last_seen_at: Date }>(
      `select u.id, u.email, u.name, u.is_platform_admin, s.id as session_id, s.last_seen_at
         from platform.auth_sessions s join platform.users u on u.id = s.user_id
        where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now() and u.status = 'active'`,
      [sha256(token)],
    ),
  );
  if (!row) return null;
  // Refresh last_seen at most every 10 minutes to avoid a write per request.
  if (Date.now() - new Date(row.last_seen_at).getTime() > 600_000) {
    await withSystem((db) => db.query("update platform.auth_sessions set last_seen_at = now() where id = $1", [row.session_id]));
  }
  return { id: row.id, email: row.email, name: row.name, isPlatformAdmin: row.is_platform_admin };
}

export async function signOut(token: string | undefined | null): Promise<void> {
  if (!token) return;
  await withSystem(async (db) => {
    const row = await db.one<{ user_id: string }>(
      "update platform.auth_sessions set revoked_at = now() where token_hash = $1 and revoked_at is null returning user_id",
      [sha256(token)],
    );
    if (row) await audit(db, { organizationId: null, actorUserId: row.user_id, action: "auth.logout" });
  });
}

/** Revokes every session for a user (password change, compromise response). */
export async function revokeAllSessions(userId: string): Promise<number> {
  const rows = await withSystem((db) =>
    db.query("update platform.auth_sessions set revoked_at = now() where user_id = $1 and revoked_at is null returning 1", [userId]),
  );
  return rows.length;
}
