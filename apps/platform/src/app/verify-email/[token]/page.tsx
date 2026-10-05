import { verifyEmailAction } from "@/app/actions/account";
import { ActionForm } from "@/components/ActionForm";
import { AuthShell } from "@/components/AuthShell";

export const metadata = { title: "Confirm your email", referrer: "no-referrer" };

/** Confirmation is a button (POST), not the page load, so link scanners in mail systems can't use the token. */
export default async function VerifyEmailPage(props: PageProps<"/verify-email/[token]">) {
  const { token } = await props.params;
  return (
    <AuthShell title="Confirm your email" subtitle="One click and your account is verified.">
      <ActionForm action={verifyEmailAction.bind(null, token)} submitLabel="Confirm email" pendingLabel="Confirming…" />
    </AuthShell>
  );
}
