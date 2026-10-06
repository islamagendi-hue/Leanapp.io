import Link from "next/link";
import { redirect } from "next/navigation";
import { signUpAction } from "@/app/actions/auth";
import { ActionForm } from "@/components/ActionForm";
import { AuthShell } from "@/components/AuthShell";
import { safeNext } from "@/lib/safe-next";
import { currentUser } from "@/server/session";

export const metadata = { title: "Create your account" };

export default async function SignUpPage(props: PageProps<"/signup">) {
  const next = safeNext((await props.searchParams).next);
  if (await currentUser()) redirect(next ?? "/onboarding");
  return (
    <AuthShell title="Create your account" subtitle="Answer a few questions, get your tracking plan, send your first event." footer={<>Already have an account? <Link className="underline" href={`/login${next ? `?next=${encodeURIComponent(next)}` : ""}`}>Sign in</Link></>}>
      <ActionForm action={signUpAction} submitLabel="Create account" pendingLabel="Creating…">
        {next && <input type="hidden" name="next" value={next} />}
        <div>
          <label className="label" htmlFor="name">Your name</label>
          <input className="input" id="name" name="name" autoComplete="name" required minLength={2} />
        </div>
        <div>
          <label className="label" htmlFor="email">Work email</label>
          <input className="input" id="email" name="email" type="email" autoComplete="email" required />
        </div>
        <div>
          <label className="label" htmlFor="password">Password</label>
          <input className="input" id="password" name="password" type="password" autoComplete="new-password" required minLength={10} />
          <p className="help">At least 10 characters with letters and a number.</p>
        </div>
      </ActionForm>
    </AuthShell>
  );
}
