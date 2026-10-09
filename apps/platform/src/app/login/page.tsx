import Link from "next/link";
import { redirect } from "next/navigation";
import { signInAction } from "@/app/actions/auth";
import { ActionForm } from "@/components/ActionForm";
import { AuthShell } from "@/components/AuthShell";
import { getT } from "@/i18n/server";
import { safeNext } from "@/lib/safe-next";
import { currentUser } from "@/server/session";

export async function generateMetadata() {
  return { title: (await getT())("Sign in") };
}

export default async function LoginPage(props: PageProps<"/login">) {
  const sp = await props.searchParams;
  const next = safeNext(sp.next);
  if (await currentUser()) redirect(next ?? "/onboarding");
  const t = await getT();
  return (
    <AuthShell title={t("Sign in")} footer={<>{t("New here?")} <Link className="underline" href={`/signup${next ? `?next=${encodeURIComponent(next)}` : ""}`}>{t("Create an account")}</Link></>}>
      {sp.reset === "1" && <p className="mb-4 rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent-ink">{t("Password changed. Sign in with your new password.")}</p>}
      <ActionForm action={signInAction} submitLabel={t("Sign in")} pendingLabel={t("Signing in…")}>
        {next && <input type="hidden" name="next" value={next} />}
        <div>
          <label className="label" htmlFor="email">{t("Email")}</label>
          <input className="input" id="email" name="email" type="email" autoComplete="email" dir="ltr" required />
        </div>
        <div>
          <label className="label" htmlFor="password">{t("Password")}</label>
          <input className="input" id="password" name="password" type="password" autoComplete="current-password" required />
          <Link href="/forgot-password" className="mt-1 inline-block text-sm text-ink-3 underline">{t("Forgot your password?")}</Link>
        </div>
      </ActionForm>
    </AuthShell>
  );
}
