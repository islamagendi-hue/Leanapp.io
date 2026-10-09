import { verifyEmailAction } from "@/app/actions/account";
import { ActionForm } from "@/components/ActionForm";
import { AuthShell } from "@/components/AuthShell";
import { getT } from "@/i18n/server";
import { safeNext } from "@/lib/safe-next";

export async function generateMetadata() {
  return { title: (await getT())("Confirm your email"), referrer: "no-referrer" as const };
}

/** Confirmation is a button (POST), not the page load, so link scanners in mail systems can't use the token. */
export default async function VerifyEmailPage(props: PageProps<"/verify-email/[token]">) {
  const { token } = await props.params;
  const next = safeNext((await props.searchParams).next);
  const t = await getT();
  return (
    <AuthShell title={t("Confirm your email")} subtitle={t("One click and your account is verified.")}>
      <ActionForm action={verifyEmailAction.bind(null, token, next)} submitLabel={t("Confirm email")} pendingLabel={t("Confirming…")} />
    </AuthShell>
  );
}
