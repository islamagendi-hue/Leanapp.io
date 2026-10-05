import Link from "next/link";
import { resetPasswordAction } from "@/app/actions/account";
import { ActionForm } from "@/components/ActionForm";
import { AuthShell } from "@/components/AuthShell";
import { isResetTokenValid } from "@/modules/auth/account";

export const metadata = { title: "Choose a new password", referrer: "no-referrer" };

export default async function ResetPasswordPage(props: PageProps<"/reset-password/[token]">) {
  const { token } = await props.params;
  if (!(await isResetTokenValid(token))) {
    return (
      <AuthShell title="This link has expired" subtitle="Reset links work once and expire after an hour.">
        <Link href="/forgot-password" className="btn">Send a new link</Link>
      </AuthShell>
    );
  }
  return (
    <AuthShell title="Choose a new password" subtitle="At least 10 characters, with letters and a number. You'll be signed out everywhere.">
      <ActionForm action={resetPasswordAction.bind(null, token)} submitLabel="Set new password" pendingLabel="Saving…">
        <div>
          <label className="label" htmlFor="password">New password</label>
          <input className="input" id="password" name="password" type="password" autoComplete="new-password" minLength={10} required />
        </div>
        <div>
          <label className="label" htmlFor="confirm">Repeat it</label>
          <input className="input" id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={10} required />
        </div>
      </ActionForm>
    </AuthShell>
  );
}
