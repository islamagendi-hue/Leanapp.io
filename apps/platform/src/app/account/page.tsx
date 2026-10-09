import Link from "next/link";
import { signOutAction } from "@/app/actions/auth";
import { AccountSections } from "@/components/account/AccountSections";
import { requireUser } from "@/server/session";

export const metadata = { title: "Your profile" };

/** The account page outside any organization (email links land here); inside one it is Settings → Your profile. */
export default async function AccountPage(props: PageProps<"/account">) {
  const sp = await props.searchParams;
  const user = await requireUser();

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-10">
      <div className="flex items-center justify-between">
        <Link href="/onboarding" className="text-sm text-ink-3 underline">← Your organizations</Link>
        <form action={signOutAction}><button className="text-sm underline" type="submit">Sign out</button></form>
      </div>
      <h1 className="h1">Your profile</h1>
      <AccountSections user={user} verified={sp.verified === "1"} />
    </main>
  );
}
