import Link from "next/link";
import { requestPasswordResetAction } from "@/app/actions/account";
import { ActionForm } from "@/components/ActionForm";
import { AuthShell } from "@/components/AuthShell";

export const metadata = { title: "Reset your password" };

export default function ForgotPasswordPage() {
  return (
    <AuthShell title="Reset your password" subtitle="We'll email you a link to choose a new one." footer={<Link className="underline" href="/login">Back to sign in</Link>}>
      <ActionForm action={requestPasswordResetAction} submitLabel="Send reset link" pendingLabel="Sending…">
        <div>
          <label className="label" htmlFor="email">Email</label>
          <input className="input" id="email" name="email" type="email" autoComplete="email" required />
        </div>
      </ActionForm>
    </AuthShell>
  );
}
