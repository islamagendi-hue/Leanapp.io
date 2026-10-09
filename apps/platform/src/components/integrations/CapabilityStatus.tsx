import { msg, type T } from "@/i18n/translate";
import type { CapabilityStatus } from "@/modules/integrations/status";

const LABEL: Record<CapabilityStatus, string> = {
  not_configured: msg("Not configured"),
  credentials_missing: msg("Credentials missing"),
  unverified: msg("Not verified"),
  verified: msg("Verified"),
  error: msg("Error"),
};

const CLS: Record<CapabilityStatus, string> = {
  not_configured: "border-line text-ink-3",
  credentials_missing: "border-warn/40 text-warn",
  unverified: "border-warn/40 text-warn",
  verified: "border-accent text-accent-ink",
  error: "border-alert/40 text-alert",
};

/** One capability's status as a pill; `null` = the viewer can't see it. */
export function CapabilityStatusPill({ t, status }: { t: T; status: CapabilityStatus | null }) {
  if (!status) return <span className="pill border-line text-ink-3">{t("No access")}</span>;
  return <span className={`pill ${CLS[status]}`}>{t(LABEL[status])}</span>;
}

export const capabilityStatusLabel = (t: T, s: CapabilityStatus) => t(LABEL[s]);
