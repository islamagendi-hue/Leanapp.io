import Link from "next/link";
import { signOutAction } from "@/app/actions/auth";
import { AccountSections } from "@/components/account/AccountSections";
import { getT } from "@/i18n/server";
import { requireUser } from "@/server/session";

export async function generateMetadata() {
  return { title: (await getT())("Your profile") };
}

/** The account page outside any organization (email links land here); inside one it is Settings → Your profile. */
export default async function AccountPage(props: PageProps<"/account">) {
  const sp = await props.searchParams;
  const user = await requireUser();
  const t = await getT();

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-10">
      <div className="flex items-center justify-between">
        <Link href="/onboarding" className="text-sm text-ink-3 underline"><span aria-hidden className="inline-block rtl:-scale-x-100">←</span> {t("Your organizations")}</Link>
        <form action={signOutAction}><button className="text-sm underline" type="submit">{t("Sign out")}</button></form>
      </div>
      <h1 className="h1">{t("Your profile")}</h1>
      <AccountSections user={user} verified={sp.verified === "1"} />
    </main>
  );
}
