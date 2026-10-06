/**
 * Account lifecycle against Postgres: email verification, password reset,
 * password change, session management and transparent password rehashing.
 * Emails go to the in-memory outbox (the "log" transport used outside production).
 */
import { randomBytes, scryptSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { withSystem } from "@/lib/db";
import {
  changePassword, isResetTokenValid, listSessions, requestPasswordReset, resetPassword, sendVerificationEmail,
  signOutOtherSessions, verifyEmail,
} from "@/modules/auth/account";
import { getUserBySessionToken, LOGIN_FAILURES_PER_EMAIL, LOGIN_FAILURES_PER_IP, signIn, signUp } from "@/modules/auth/service";
import { outbox } from "@/modules/email/service";
import { acceptInvitation, inviteMember } from "@/modules/organizations/service";
import { makeTenant } from "./helpers";

let n = 0;
async function newUser(password = "correct-horse-9") {
  n++;
  const email = `acct-${n}-${Date.now()}@example.com`;
  const s = await signUp({ name: `Account ${n}`, email, password }, { ip: `10.9.${n}.1` });
  return { ...s, email, password };
}

/** The token is the last path segment of the first link in the newest email to `to`. */
function linkTokenFor(to: string, kind: string): string {
  const msg = [...outbox].reverse().find((m) => m.to === to && m.kind === kind);
  expect(msg, `no ${kind} email for ${to}`).toBeDefined();
  const url = msg!.text.match(/https?:\/\/\S+/)![0];
  return url.split("/").pop()!;
}

beforeEach(() => {
  outbox.length = 0;
});

describe("email verification", () => {
  it("verifies once, with the newest link only", async () => {
    const u = await newUser();
    expect(u.user.emailVerified).toBe(false);

    await sendVerificationEmail(u.user.id);
    const first = linkTokenFor(u.email, "verify_email");
    await sendVerificationEmail(u.user.id);
    const second = linkTokenFor(u.email, "verify_email");
    expect(second).not.toBe(first);

    expect(await verifyEmail(first)).toBeNull(); // superseded
    expect(await verifyEmail(second)).toEqual({ userId: u.user.id });
    expect(await verifyEmail(second)).toBeNull(); // single use
    expect((await getUserBySessionToken(u.token))?.emailVerified).toBe(true);

    expect(await sendVerificationEmail(u.user.id)).toEqual({ delivered: false, transport: "skipped" });
    expect(await verifyEmail("not-a-token")).toBeNull();
  });

  it("rejects a link sent to an address the account no longer uses", async () => {
    const u = await newUser();
    await sendVerificationEmail(u.user.id);
    const token = linkTokenFor(u.email, "verify_email");
    await withSystem((db) => db.query("update platform.users set email = $2 where id = $1", [u.user.id, `changed-${u.email}`]));
    expect(await verifyEmail(token)).toBeNull();
  });
});

describe("password reset", () => {
  it("answers the same for unknown emails and sends nothing", async () => {
    await expect(requestPasswordReset({ email: "nobody-here@example.com" }, { ip: "10.8.0.1" })).resolves.toBeUndefined();
    expect(outbox).toHaveLength(0);
    await expect(requestPasswordReset({ email: "not an email" }, { ip: "10.8.0.1" })).rejects.toThrow(/valid email/);
  });

  it("resets, signs out every session, verifies the email and confirms by email", async () => {
    const u = await newUser();
    const other = await signIn({ email: u.email, password: u.password }, { ip: "10.8.1.1" });

    await requestPasswordReset({ email: u.email.toUpperCase() }, { ip: "10.8.1.2" });
    const token = linkTokenFor(u.email, "password_reset");
    expect(await isResetTokenValid(token)).toBe(true);

    await expect(resetPassword(token, "short")).rejects.toThrow();
    expect(await isResetTokenValid(token)).toBe(true); // a rejected password doesn't burn the link

    await resetPassword(token, "brand-new-pass-7");
    expect(await isResetTokenValid(token)).toBe(false);
    await expect(resetPassword(token, "another-pass-8")).rejects.toThrow(/invalid or has expired/);

    expect(await getUserBySessionToken(u.token)).toBeNull();
    expect(await getUserBySessionToken(other.token)).toBeNull();
    expect(outbox.some((m) => m.to === u.email && m.kind === "password_changed")).toBe(true);

    await expect(signIn({ email: u.email, password: u.password }, { ip: "10.8.1.3" })).rejects.toThrow(/incorrect/);
    const s = await signIn({ email: u.email, password: "brand-new-pass-7" }, { ip: "10.8.1.3" });
    expect(s.user.emailVerified).toBe(true);
  });

  it("throttles repeated requests for one email", async () => {
    const u = await newUser();
    for (let i = 0; i < 3; i++) await requestPasswordReset({ email: u.email }, { ip: `10.8.2.${i}` });
    await expect(requestPasswordReset({ email: u.email }, { ip: "10.8.2.9" })).rejects.toThrow();
  });
});

describe("signed-in account management", () => {
  it("changes the password, keeping only the current session", async () => {
    const u = await newUser();
    const other = await signIn({ email: u.email, password: u.password }, { ip: "10.7.0.1" });

    await expect(changePassword(u.user.id, { currentPassword: "wrong-pass-1", newPassword: "next-pass-word-2" }, u.token)).rejects.toThrow(/incorrect/);
    await expect(changePassword(u.user.id, { currentPassword: u.password, newPassword: u.password }, u.token)).rejects.toThrow(/haven't used/);

    await changePassword(u.user.id, { currentPassword: u.password, newPassword: "next-pass-word-2" }, u.token);
    expect((await getUserBySessionToken(u.token))?.id).toBe(u.user.id);
    expect(await getUserBySessionToken(other.token)).toBeNull();
    expect(outbox.some((m) => m.to === u.email && m.kind === "password_changed")).toBe(true);
    await signIn({ email: u.email, password: "next-pass-word-2" }, { ip: "10.7.0.2" });
  });

  it("lists sessions with the current one marked and signs out the others", async () => {
    const u = await newUser();
    await signIn({ email: u.email, password: u.password }, { ip: "10.7.1.1", userAgent: "Phone" });
    const sessions = await listSessions(u.user.id, u.token);
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((s) => s.current)).toHaveLength(1);

    expect(await signOutOtherSessions(u.user.id, u.token)).toBe(1);
    const left = await listSessions(u.user.id, u.token);
    expect(left).toHaveLength(1);
    expect(left[0].current).toBe(true);
  });
});

describe("password hashing upgrades", () => {
  it("rehashes a hash with outdated parameters on successful sign-in", async () => {
    const u = await newUser();
    const salt = randomBytes(16);
    const legacy = `scrypt$1024$8$1$${salt.toString("base64")}$${scryptSync(u.password, salt, 64, { N: 1024, r: 8, p: 1 }).toString("base64")}`;
    await withSystem((db) => db.query("update platform.users set password_hash = $2 where id = $1", [u.user.id, legacy]));
    await signIn({ email: u.email, password: u.password }, { ip: "10.6.0.1" });
    const row = await withSystem((db) => db.one<{ password_hash: string }>("select password_hash from platform.users where id = $1", [u.user.id]));
    expect(row!.password_hash).not.toBe(legacy);
    await signIn({ email: u.email, password: u.password }, { ip: "10.6.0.2" });
  });
});

describe("invitations", () => {
  it("emails the invitation link, which the invitee can accept once their email is confirmed", async () => {
    const t = await makeTenant("invite");
    const invitee = await newUser();
    const { link, delivery } = await inviteMember(t.ctx, { email: invitee.email, role: "developer" });
    expect(delivery.delivered).toBe(true);
    const msg = outbox.find((m) => m.kind === "invitation" && m.to === invitee.email)!;
    expect(msg.subject).toContain(t.ctx.organizationName);
    expect(msg.text).toContain(link);
    const token = link.split("/").pop()!;

    // Anyone can sign up with an address; only confirming it proves it's theirs.
    await expect(acceptInvitation({ id: invitee.user.id }, token)).rejects.toThrow(/Confirm your email/);

    // The confirmation link carries the invitation as `next`, so confirming leads back to it.
    await sendVerificationEmail(invitee.user.id, { next: `/invite/${token}` });
    const url = new URL([...outbox].reverse().find((m) => m.to === invitee.email && m.kind === "verify_email")!.text.match(/https?:\/\/\S+/)![0]);
    expect(url.searchParams.get("next")).toBe(`/invite/${token}`);
    expect(await verifyEmail(url.pathname.split("/").pop()!)).toEqual({ userId: invitee.user.id });

    const org = await acceptInvitation({ id: invitee.user.id }, token);
    expect(org.slug).toBe(t.org.slug);
  });

  it("drops an unsafe next from the confirmation link", async () => {
    const u = await newUser();
    await sendVerificationEmail(u.user.id, { next: "/\\evil.example" });
    const url = new URL([...outbox].reverse().find((m) => m.to === u.email && m.kind === "verify_email")!.text.match(/https?:\/\/\S+/)![0]);
    expect(url.search).toBe("");
  });

  it("refuses an invitation sent to another address, even when confirmed", async () => {
    const t = await makeTenant("invite-other");
    const invitee = await newUser();
    const stranger = await newUser();
    await withSystem((db) => db.query("update platform.users set email_verified_at = now() where id = $1", [stranger.user.id]));
    const { token } = await inviteMember(t.ctx, { email: invitee.email, role: "developer" });
    await expect(acceptInvitation({ id: stranger.user.id }, token)).rejects.toThrow(/was sent to/);
  });
});

describe("sign-in throttling", () => {
  it("counts only failures, per email and IP, so others can't lock the owner out", async () => {
    const u = await newUser();
    for (let i = 0; i < LOGIN_FAILURES_PER_IP; i++) {
      await expect(signIn({ email: u.email, password: "wrong-pass-1" }, { ip: "10.5.0.1" })).rejects.toThrow(/incorrect/);
    }
    // The attacker's IP is now throttled for this email, even with the right password…
    await expect(signIn({ email: u.email, password: u.password }, { ip: "10.5.0.1" })).rejects.toThrow(/Too many|try again/i);
    // …but the owner signs in from elsewhere, as often as they like.
    for (let i = 0; i < LOGIN_FAILURES_PER_IP + 2; i++) await signIn({ email: u.email, password: u.password }, { ip: "10.5.0.2" });
  });

  it("caps failures per email across all IPs", async () => {
    const u = await newUser();
    await withSystem((db) =>
      db.query(
        "insert into platform.rate_limit_buckets (key, window_start, count) values ($1, to_timestamp(floor(extract(epoch from now()) / 900) * 900), $2)",
        [`login:fail:${u.email}`, LOGIN_FAILURES_PER_EMAIL],
      ),
    );
    await expect(signIn({ email: u.email, password: u.password }, { ip: "10.5.1.1" })).rejects.toThrow(/Too many|try again/i);
  });
});
