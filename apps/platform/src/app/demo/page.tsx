import Link from "next/link";
import { startDemoAction } from "@/app/actions/demo";
import { AuthShell } from "@/components/AuthShell";
import { demoEnabled } from "@/modules/marketing/demo";

export const metadata = { title: "Live demo" };

/** A shareable link to the demo: one button, so opening the link never signs anyone in by itself. */
export default async function DemoPage(props: PageProps<"/demo">) {
  const sp = await props.searchParams;
  return (
    <AuthShell title="LeanApp live demo" footer={<>Want your own app in it? <Link className="underline" href="/signup">Create a free account</Link></>}>
      <div className="space-y-4" dir="auto">
        <p className="text-ink-2">Explore a food delivery app with 30 days of sample data: Overview, funnels, retention, users and acquisition. It is read-only and nothing in it is real.</p>
        <p className="text-ink-2" dir="rtl" lang="ar">جرّب تطبيق توصيل طعام فيه بيانات تجريبية لآخر 30 يوم. للعرض فقط، ومفيش أي بيانات حقيقية.</p>
        {sp.error === "1" && <p role="alert" className="rounded-lg bg-alert-soft px-3 py-2 text-sm text-alert">The demo couldn&apos;t open. Please try again in a minute.</p>}
        {demoEnabled() ? (
          <form action={startDemoAction}><button className="btn w-full" type="submit">Open the demo · افتح الديمو</button></form>
        ) : (
          <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">The demo isn&apos;t switched on here.</p>
        )}
      </div>
    </AuthShell>
  );
}
