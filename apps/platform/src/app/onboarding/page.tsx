import Link from "next/link";
import { createOrganizationAction } from "@/app/actions/organizations";
import { ActionForm } from "@/components/ActionForm";
import { AuthShell } from "@/components/AuthShell";
import { INDUSTRIES, listOrganizationsForUser } from "@/modules/organizations/service";
import { requireUser } from "@/server/session";

export const metadata = { title: "Create your organization" };

const COUNTRIES: [string, string, string, string][] = [
  ["SA", "Saudi Arabia", "Asia/Riyadh", "SAR"], ["AE", "United Arab Emirates", "Asia/Dubai", "AED"], ["EG", "Egypt", "Africa/Cairo", "EGP"],
  ["KW", "Kuwait", "Asia/Kuwait", "KWD"], ["QA", "Qatar", "Asia/Qatar", "QAR"], ["BH", "Bahrain", "Asia/Bahrain", "BHD"],
  ["OM", "Oman", "Asia/Muscat", "OMR"], ["JO", "Jordan", "Asia/Amman", "JOD"], ["LB", "Lebanon", "Asia/Beirut", "LBP"],
  ["IQ", "Iraq", "Asia/Baghdad", "IQD"], ["MA", "Morocco", "Africa/Casablanca", "MAD"],
];

export default async function OnboardingPage() {
  const user = await requireUser();
  const orgs = await listOrganizationsForUser(user.id);
  return (
    <AuthShell
      title={orgs.length ? "Your organizations" : "Create your organization"}
      subtitle={orgs.length ? undefined : "An organization holds your apps, team and billing. You can add more apps later."}
    >
      {orgs.length > 0 && (
        <ul className="mb-6 space-y-2">
          {orgs.map((o) => (
            <li key={o.id}>
              <Link href={`/o/${o.slug}`} className="flex items-center justify-between rounded-lg border border-line px-3 py-2 hover:bg-paper-2">
                <span className="font-medium">{o.name}</span>
                <span className="pill border-line text-ink-3">{o.role}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {orgs.length > 0 && <h2 className="h2 mb-3">New organization</h2>}
      <ActionForm action={createOrganizationAction} submitLabel="Create organization">
        <div>
          <label className="label" htmlFor="name">Company name</label>
          <input className="input" id="name" name="name" required minLength={2} placeholder="ABC Technology" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="country">Country</label>
            <select className="input" id="country" name="country" defaultValue="SA">
              {COUNTRIES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
              <option value="">Other</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="industry">Industry</label>
            <select className="input" id="industry" name="industry" defaultValue="">
              <option value="">Choose…</option>
              {INDUSTRIES.map((i) => <option key={i} value={i}>{i.replace(/_/g, " ")}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="timezone">Timezone</label>
            <select className="input" id="timezone" name="timezone" defaultValue="Asia/Riyadh">
              {[...new Set(COUNTRIES.map((c) => c[2]))].map((tz) => <option key={tz}>{tz}</option>)}
              <option>UTC</option>
              <option>Europe/London</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="currency">Default currency</label>
            <select className="input" id="currency" name="currency" defaultValue="SAR">
              {[...new Set(COUNTRIES.map((c) => c[3]))].map((c) => <option key={c}>{c}</option>)}
              <option>USD</option>
              <option>EUR</option>
            </select>
          </div>
        </div>
      </ActionForm>
    </AuthShell>
  );
}
