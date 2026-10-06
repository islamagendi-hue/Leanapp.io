import Link from "next/link";
import { changePasswordAction, resendVerificationAction, signOutOtherSessionsAction } from "@/app/actions/account";
import { signOutAction } from "@/app/actions/auth";
import { ActionForm } from "@/components/ActionForm";
import { listSessions } from "@/modules/auth/account";
import { requireUser, sessionToken } from "@/server/session";

export const metadata = { title: "Your account" };

function device(ua: string | null): string {
  if (!ua) return "Unknown device";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return [browser, os].filter(Boolean).join(" on ");
}

export default async function AccountPage(props: PageProps<"/account">) {
  const sp = await props.searchParams;
  const user = await requireUser();
  const sessions = await listSessions(user.id, (await sessionToken()) ?? null);

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-10">
      <div className="flex items-center justify-between">
        <Link href="/onboarding" className="text-sm text-ink-3 underline">← Your organizations</Link>
        <form action={signOutAction}><button className="text-sm underline" type="submit">Sign out</button></form>
      </div>
      <h1 className="h1">Your account</h1>
      {sp.verified === "1" && <p className="rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent-ink">Email confirmed. Thanks.</p>}

      <section className="card space-y-3">
        <h2 className="h2">Profile</h2>
        <dl className="grid grid-cols-[120px_1fr] gap-y-2 text-sm">
          <dt className="text-ink-3">Name</dt><dd>{user.name}</dd>
          <dt className="text-ink-3">Email</dt>
          <dd>
            {user.email}{" "}
            {user.emailVerified ? <span className="pill border-accent/50 text-accent-ink">confirmed</span> : <span className="pill border-warn/50 text-warn">not confirmed</span>}
          </dd>
        </dl>
        {!user.emailVerified && (
          <ActionForm action={resendVerificationAction} submitLabel="Send confirmation email" buttonClass="btn-secondary" pendingLabel="Sending…" />
        )}
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

      <section className="card">
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
    </main>
  );
}
