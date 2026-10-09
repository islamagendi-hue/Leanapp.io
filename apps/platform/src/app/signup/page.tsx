import Link from "next/link";
import { redirect } from "next/navigation";
import { signUpAction } from "@/app/actions/auth";
import { ActionForm } from "@/components/ActionForm";
import { AuthShell } from "@/components/AuthShell";
import { getT } from "@/i18n/server";
import { safeNext } from "@/lib/safe-next";
import { currentUser } from "@/server/session";

export async function generateMetadata() {
  return { title: (await getT())("Create your account") };
}

export default async function SignUpPage(props: PageProps<"/signup">) {
  const next = safeNext((await props.searchParams).next);
  if (await currentUser()) redirect(next ?? "/onboarding");
  const t = await getT();
  return (
    <AuthShell title={t("Create your account")} subtitle={t("Answer a few questions about your app, get your tracking plan, then send your first event to LeanApp.")} footer={<>{t("Already have an account?")} <Link className="underline" href={`/login${next ? `?next=${encodeURIComponent(next)}` : ""}`}>{t("Sign in")}</Link></>}>
      <ActionForm action={signUpAction} submitLabel={t("Create account")} pendingLabel={t("Creating…")}>
        {next && <input type="hidden" name="next" value={next} />}
        <div>
          <label className="label" htmlFor="name">{t("Your name")}</label>
          <input className="input" id="name" name="name" autoComplete="name" required minLength={2} />
        </div>
        <div>
          <label className="label" htmlFor="email">{t("Work email")}</label>
          <input className="input" id="email" name="email" type="email" autoComplete="email" dir="ltr" required />
        </div>
        <div>
          <label className="label" htmlFor="password">{t("Password")}</label>
          <input className="input" id="password" name="password" type="password" autoComplete="new-password" required minLength={10} />
          <p className="help">{t("At least 10 characters with letters and a number.")}</p>
        </div>
      </ActionForm>
    </AuthShell>
  );
}
