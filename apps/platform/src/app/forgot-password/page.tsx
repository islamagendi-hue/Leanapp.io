import Link from "next/link";
import { requestPasswordResetAction } from "@/app/actions/account";
import { ActionForm } from "@/components/ActionForm";
import { AuthShell } from "@/components/AuthShell";
import { getT } from "@/i18n/server";

export async function generateMetadata() {
  return { title: (await getT())("Reset your password") };
}

export default async function ForgotPasswordPage() {
  const t = await getT();
  return (
    <AuthShell title={t("Reset your password")} subtitle={t("We'll email you a link to choose a new one.")} footer={<Link className="underline" href="/login">{t("Back to sign in")}</Link>}>
      <ActionForm action={requestPasswordResetAction} submitLabel={t("Send reset link")} pendingLabel={t("Sending…")}>
        <div>
          <label className="label" htmlFor="email">{t("Email")}</label>
          <input className="input" id="email" name="email" type="email" autoComplete="email" dir="ltr" required />
        </div>
      </ActionForm>
    </AuthShell>
  );
}
