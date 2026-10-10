import { redirect } from "next/navigation";
import { resendVerificationAction } from "@/app/actions/account";
import { acceptInvitationAction } from "@/app/actions/organizations";
import { ActionForm } from "@/components/ActionForm";
import { AuthShell } from "@/components/AuthShell";
import { getT } from "@/i18n/server";
import { currentUser } from "@/server/session";

export async function generateMetadata() {
  return { title: (await getT())("Join organization") };
}

export default async function InvitePage(props: PageProps<"/invite/[token]">) {
  const { token } = await props.params;
  const user = await currentUser();
  const back = `/invite/${encodeURIComponent(token)}`;
  if (!user) redirect(`/signup?next=${encodeURIComponent(back)}`);
  const t = await getT();
  // The invitation is addressed to an email, so the account must prove it owns that address first.
  if (!user.emailVerified) {
    return (
      <AuthShell title={t("Confirm your email first")} subtitle={t("You're signed in as {email}. Confirm this address, then come back here to join the team.", { email: user.email })}>
        <p className="mb-4 text-sm text-ink-3">{t("Use the confirmation link we emailed you, or send a new one. It brings you straight back to this invitation.")}</p>
        <ActionForm action={resendVerificationAction} submitLabel={t("Send confirmation email")} pendingLabel={t("Sending…")}>
          <input type="hidden" name="next" value={back} />
        </ActionForm>
      </AuthShell>
    );
  }
  return (
    <AuthShell title={t("Join your team")} subtitle={t("You're signed in as {email}. The invitation must have been sent to this email.", { email: user.email })}>
      <ActionForm action={acceptInvitationAction.bind(null, token)} submitLabel={t("Accept invitation")} />
    </AuthShell>
  );
}
