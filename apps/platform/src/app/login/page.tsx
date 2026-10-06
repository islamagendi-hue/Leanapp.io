import Link from "next/link";
import { redirect } from "next/navigation";
import { signInAction } from "@/app/actions/auth";
import { ActionForm } from "@/components/ActionForm";
import { AuthShell } from "@/components/AuthShell";
import { safeNext } from "@/lib/safe-next";
import { currentUser } from "@/server/session";

export const metadata = { title: "Sign in" };

export default async function LoginPage(props: PageProps<"/login">) {
  const sp = await props.searchParams;
  const next = safeNext(sp.next);
  if (await currentUser()) redirect(next ?? "/onboarding");
  return (
    <AuthShell title="Sign in" footer={<>New here? <Link className="underline" href={`/signup${next ? `?next=${encodeURIComponent(next)}` : ""}`}>Create an account</Link></>}>
      {sp.reset === "1" && <p className="mb-4 rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent-ink">Password changed. Sign in with your new password.</p>}
      <ActionForm action={signInAction} submitLabel="Sign in" pendingLabel="Signing in…">
        {next && <input type="hidden" name="next" value={next} />}
        <div>
          <label className="label" htmlFor="email">Email</label>
          <input className="input" id="email" name="email" type="email" autoComplete="email" required />
        </div>
        <div>
          <label className="label" htmlFor="password">Password</label>
          <input className="input" id="password" name="password" type="password" autoComplete="current-password" required />
          <Link href="/forgot-password" className="mt-1 inline-block text-sm text-ink-3 underline">Forgot your password?</Link>
        </div>
      </ActionForm>
    </AuthShell>
  );
}
