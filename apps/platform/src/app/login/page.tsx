import Link from "next/link";
import { redirect } from "next/navigation";
import { signInAction } from "@/app/actions/auth";
import { ActionForm } from "@/components/ActionForm";
import { AuthShell } from "@/components/AuthShell";
import { currentUser } from "@/server/session";

export const metadata = { title: "Sign in" };

export default async function LoginPage(props: PageProps<"/login">) {
  const next = (await props.searchParams).next;
  if (await currentUser()) redirect(typeof next === "string" ? next : "/onboarding");
  return (
    <AuthShell title="Sign in" footer={<>New here? <Link className="underline" href={`/signup${typeof next === "string" ? `?next=${encodeURIComponent(next)}` : ""}`}>Create an account</Link></>}>
      <ActionForm action={signInAction} submitLabel="Sign in" pendingLabel="Signing in…">
        {typeof next === "string" && <input type="hidden" name="next" value={next} />}
        <div>
          <label className="label" htmlFor="email">Email</label>
          <input className="input" id="email" name="email" type="email" autoComplete="email" required />
        </div>
        <div>
          <label className="label" htmlFor="password">Password</label>
          <input className="input" id="password" name="password" type="password" autoComplete="current-password" required />
        </div>
      </ActionForm>
    </AuthShell>
  );
}
