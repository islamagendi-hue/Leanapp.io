import Link from "next/link";
import { resetPasswordAction } from "@/app/actions/account";
import { ActionForm } from "@/components/ActionForm";
import { AuthShell } from "@/components/AuthShell";
import { getT } from "@/i18n/server";
import { isResetTokenValid } from "@/modules/auth/account";

export async function generateMetadata() {
  return { title: (await getT())("Choose a new password"), referrer: "no-referrer" as const };
}

export default async function ResetPasswordPage(props: PageProps<"/reset-password/[token]">) {
  const { token } = await props.params;
  const t = await getT();
  if (!(await isResetTokenValid(token))) {
    return (
      <AuthShell title={t("This link has expired")} subtitle={t("Reset links work once and expire after an hour.")}>
        <Link href="/forgot-password" className="btn">{t("Send a new link")}</Link>
      </AuthShell>
    );
  }
  return (
    <AuthShell title={t("Choose a new password")} subtitle={t("At least 10 characters, with letters and a number. You'll be signed out everywhere.")}>
      <ActionForm action={resetPasswordAction.bind(null, token)} submitLabel={t("Set new password")} pendingLabel={t("Saving…")}>
        <div>
          <label className="label" htmlFor="password">{t("New password")}</label>
          <input className="input" id="password" name="password" type="password" autoComplete="new-password" minLength={10} required />
        </div>
        <div>
          <label className="label" htmlFor="confirm">{t("Repeat it")}</label>
          <input className="input" id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={10} required />
        </div>
      </ActionForm>
    </AuthShell>
  );
}
