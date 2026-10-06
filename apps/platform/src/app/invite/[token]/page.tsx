import { redirect } from "next/navigation";
import { resendVerificationAction } from "@/app/actions/account";
import { acceptInvitationAction } from "@/app/actions/organizations";
import { ActionForm } from "@/components/ActionForm";
import { AuthShell } from "@/components/AuthShell";
import { currentUser } from "@/server/session";

export const metadata = { title: "Join organization" };

export default async function InvitePage(props: PageProps<"/invite/[token]">) {
  const { token } = await props.params;
  const user = await currentUser();
  const back = `/invite/${encodeURIComponent(token)}`;
  if (!user) redirect(`/signup?next=${encodeURIComponent(back)}`);
  // The invitation is addressed to an email, so the account must prove it owns that address first.
  if (!user.emailVerified) {
    return (
      <AuthShell title="Confirm your email first" subtitle={`You're signed in as ${user.email}. Confirm this address, then come back here to join the team.`}>
        <p className="mb-4 text-sm text-ink-3">Use the confirmation link we emailed you, or send a new one. It brings you straight back to this invitation.</p>
        <ActionForm action={resendVerificationAction} submitLabel="Send confirmation email" pendingLabel="Sending…">
          <input type="hidden" name="next" value={back} />
        </ActionForm>
      </AuthShell>
    );
  }
  return (
    <AuthShell title="Join your team" subtitle={`You're signed in as ${user.email}. The invitation must have been sent to this email.`}>
      <ActionForm action={acceptInvitationAction.bind(null, token)} submitLabel="Accept invitation" />
    </AuthShell>
  );
}
