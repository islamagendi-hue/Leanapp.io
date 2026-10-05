import { redirect } from "next/navigation";
import { acceptInvitationAction } from "@/app/actions/organizations";
import { ActionForm } from "@/components/ActionForm";
import { AuthShell } from "@/components/AuthShell";
import { currentUser } from "@/server/session";

export const metadata = { title: "Join organization" };

export default async function InvitePage(props: PageProps<"/invite/[token]">) {
  const { token } = await props.params;
  const user = await currentUser();
  if (!user) redirect(`/signup?next=${encodeURIComponent(`/invite/${token}`)}`);
  return (
    <AuthShell title="Join your team" subtitle={`You're signed in as ${user.email}. The invitation must have been sent to this email.`}>
      <ActionForm action={acceptInvitationAction.bind(null, token)} submitLabel="Accept invitation" />
    </AuthShell>
  );
}
