import { AccountSections } from "@/components/account/AccountSections";
import { getT } from "@/i18n/server";
import { requireUser } from "@/server/session";

export async function generateMetadata() {
  return { title: (await getT())("Your profile") };
}

export default async function ProfilePage() {
  const user = await requireUser();
  const t = await getT();
  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="h1">{t("Your profile")}</h1>
        <p className="mt-1 text-ink-2">{t("Your name, password and sessions. They are yours, the same in every organization you belong to.")}</p>
      </div>
      <AccountSections user={user} />
    </div>
  );
}
