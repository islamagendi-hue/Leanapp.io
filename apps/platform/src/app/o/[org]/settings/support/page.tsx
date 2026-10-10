import { contactSupportAction } from "@/app/actions/support";
import { ActionForm } from "@/components/ActionForm";
import { getT } from "@/i18n/server";
import { SUPPORT_EMAIL } from "@/modules/support/contact";
import { requireTenant } from "@/server/session";

export async function generateMetadata() {
  return { title: (await getT())("Help & support") };
}

export default async function SupportPage(props: PageProps<"/o/[org]/settings/support">) {
  const { org } = await props.params;
  await requireTenant(org);
  const t = await getT();
  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="h1">{t("Help & support")}</h1>
        <p className="mt-1 text-ink-2">{t("Something not working, or a question about your setup? Write to us in Arabic or English and we'll reply by email.")}</p>
      </div>
      <section className="card">
        <ActionForm action={contactSupportAction.bind(null, org)} submitLabel={t("Send to support")} pendingLabel={t("Sending…")}>
          <label className="block space-y-1">
            <span className="label">{t("Topic")}</span>
            <select name="topic" className="input" defaultValue="question">
              <option value="question">{t("A question")}</option>
              <option value="problem">{t("Something isn't working")}</option>
              <option value="billing">{t("Billing and plan")}</option>
              <option value="feature">{t("A feature request")}</option>
            </select>
          </label>
          <label className="block space-y-1">
            <span className="label">{t("Subject")}</span>
            <input name="subject" className="input" maxLength={150} required />
          </label>
          <label className="block space-y-1">
            <span className="label">{t("Message")}</span>
            <textarea name="message" className="input min-h-36" maxLength={5000} required placeholder={t("What happened, on which page, and what you expected.")} />
          </label>
        </ActionForm>
      </section>
      <p className="text-sm text-ink-2">
        {t("Or email us directly:")}{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`} className="underline" dir="ltr">{SUPPORT_EMAIL}</a>
      </p>
    </div>
  );
}
