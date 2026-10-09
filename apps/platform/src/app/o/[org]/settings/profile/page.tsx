import { AccountSections } from "@/components/account/AccountSections";
import { requireUser } from "@/server/session";

export const metadata = { title: "Your profile" };

export default async function ProfilePage() {
  const user = await requireUser();
  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="h1">Your profile</h1>
        <p className="mt-1 text-ink-2">Your name, password and sessions. They are yours, the same in every organization you belong to.</p>
      </div>
      <AccountSections user={user} />
    </div>
  );
}
