import Link from "next/link";
import { changePasswordAction, resendVerificationAction, signOutOtherSessionsAction, updateProfileAction } from "@/app/actions/account";
import { ActionForm } from "@/components/ActionForm";
import { listSessions } from "@/modules/auth/account";
import type { AuthUser } from "@/modules/auth/service";
import { listOrganizationsForUser } from "@/modules/organizations/service";
import { ROLE_INFO } from "@/modules/rbac/permissions";
import { sessionToken } from "@/server/session";

function device(ua: string | null): string {
  if (!ua) return "Unknown device";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return [browser, os].filter(Boolean).join(" on ");
}

/** Initials for an avatar: the first letters of the first two words of a name, else of the email. */
export function initials(name: string | null | undefined, email: string): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  const letters = words.length ? words.slice(0, 2).map((w) => w[0]) : [email[0]];
  return letters.join("").toUpperCase();
}

/**
 * The signed-in person's own account: profile, organizations, password and
 * sessions. Shown at /account and, inside an organization, in Settings → Your
 * profile, so it is the same page wherever it is opened from.
 */
export async function AccountSections({ user, verified }: { user: AuthUser; verified?: boolean }) {
  const [sessions, orgs] = await Promise.all([listSessions(user.id, (await sessionToken()) ?? null), listOrganizationsForUser(user.id)]);
  return (
    <>
      {verified && <p className="rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent-ink">Email confirmed. Thanks.</p>}

      <section className="card space-y-4" aria-label="Profile">
        <div className="flex items-center gap-4">
          <span className="grid size-14 shrink-0 place-items-center rounded-full bg-ink text-lg font-bold text-paper" aria-hidden>{initials(user.name, user.email)}</span>
          <div className="min-w-0">
            <p className="text-lg font-bold">{user.name}</p>
            <p className="truncate text-sm text-ink-2">
              {user.email}{" "}
              {user.emailVerified ? <span className="pill border-accent/50 text-accent-ink">confirmed</span> : <span className="pill border-warn/50 text-warn">not confirmed</span>}
            </p>
          </div>
        </div>
        <ActionForm action={updateProfileAction} submitLabel="Save" pendingLabel="Saving…" className="flex flex-wrap items-end gap-3">
          <label className="min-w-60 flex-1"><span className="label">Name</span><input className="input" name="name" defaultValue={user.name} autoComplete="name" required minLength={2} maxLength={120} /></label>
        </ActionForm>
        <p className="text-xs text-ink-3">Your teammates see this name in Members and in the audit log. To use another email, ask an owner to invite it.</p>
        {!user.emailVerified && (
          <ActionForm action={resendVerificationAction} submitLabel="Send confirmation email" buttonClass="btn-secondary" pendingLabel="Sending…" />
        )}
      </section>

      <section className="card" aria-label="Your organizations">
        <h2 className="h2">Your organizations</h2>
        <ul className="mt-3 divide-y divide-line text-sm">
          {orgs.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <Link className="font-medium hover:underline" href={`/o/${o.slug}`}>{o.name}</Link>
              <span className="pill border-line">{ROLE_INFO[o.role].name}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-sm"><Link className="underline" href="/onboarding">Create another organization</Link></p>
      </section>

      <section className="card">
        <h2 className="h2">Change password</h2>
        <p className="mb-4 text-sm text-ink-3">Your other sessions are signed out when the password changes.</p>
        <ActionForm action={changePasswordAction} submitLabel="Change password" pendingLabel="Saving…">
          <div>
            <label className="label" htmlFor="currentPassword">Current password</label>
            <input className="input" id="currentPassword" name="currentPassword" type="password" autoComplete="current-password" required />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="newPassword">New password</label>
              <input className="input" id="newPassword" name="newPassword" type="password" autoComplete="new-password" minLength={10} required />
            </div>
            <div>
              <label className="label" htmlFor="confirm">Repeat new password</label>
              <input className="input" id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={10} required />
            </div>
          </div>
        </ActionForm>
      </section>

      <section id="sessions" className="card scroll-mt-24">
        <h2 className="h2">Where you&apos;re signed in</h2>
        <ul className="mt-3 divide-y divide-line text-sm">
          {sessions.map((s) => (
            <li key={s.id} className="flex flex-wrap justify-between gap-2 py-2">
              <span>{device(s.user_agent)} {s.current && <span className="pill ms-1 border-accent/50 text-accent-ink">this device</span>}</span>
              <span className="text-xs text-ink-3">last active {new Date(s.last_seen_at).toLocaleString("en-GB")}</span>
            </li>
          ))}
        </ul>
        {sessions.length > 1 && (
          <ActionForm action={signOutOtherSessionsAction} submitLabel="Sign out all other sessions" buttonClass="btn-secondary mt-3" className="mt-3" confirm="Sign out every other device?" />
        )}
      </section>
    </>
  );
}
