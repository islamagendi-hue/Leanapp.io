import Link from "next/link";
import { startDemoAction } from "@/app/actions/demo";
import { AuthShell } from "@/components/AuthShell";
import { getT } from "@/i18n/server";
import { demoEnabled } from "@/modules/marketing/demo";

export async function generateMetadata() {
  return { title: (await getT())("Live demo") };
}

/** A shareable link to the demo: one button, so opening the link never signs anyone in by itself. */
export default async function DemoPage(props: PageProps<"/demo">) {
  const sp = await props.searchParams;
  const t = await getT();
  return (
    <AuthShell title={t("LeanApp live demo")} footer={<>{t("Want your own app in it?")} <Link className="underline" href="/signup">{t("Create your account")}</Link></>}>
      <div className="space-y-4">
        <p className="text-ink-2">{t("Explore a sample food delivery app with 30 days of data: Overview, funnels, retention, users and acquisition. You can only view it, and nothing in it is real.")}</p>
        {sp.error === "1" && <p role="alert" className="rounded-lg bg-alert-soft px-3 py-2 text-sm text-alert">{t("The demo couldn't open. Please try again in a minute.")}</p>}
        {demoEnabled() ? (
          <form action={startDemoAction}><button className="btn w-full" type="submit">{t("Open the demo")}</button></form>
        ) : (
          <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">{t("The demo isn't switched on here.")}</p>
        )}
      </div>
    </AuthShell>
  );
}
