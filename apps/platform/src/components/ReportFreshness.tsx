import Link from "next/link";
import { getT } from "@/i18n/server";
import { REPORT_CACHE_TTL_SECONDS } from "@/modules/analytics/cache";
import type { FreshnessInfo } from "@/server/analytics-page";

/** "Computed 4 min ago · Refresh" under a report that was served from the result cache. */
export async function ReportFreshness({ info, path, sp, className = "" }: { info: FreshnessInfo; path: string; sp: Record<string, string | string[] | undefined>; className?: string }) {
  if (!info.fromCache || !info.computedAt) return null;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (k === "fresh" || v === undefined) continue;
    for (const x of Array.isArray(v) ? v : [v]) q.append(k, x);
  }
  q.set("fresh", "1");
  const minutes = info.ageMinutes;
  const t = await getT();
  const ttl = REPORT_CACHE_TTL_SECONDS / 60;
  return (
    <p className={`text-balance text-xs text-ink-3 ${className}`}>
      {minutes === 0 ? t("Computed less than a minute ago; results are reused for up to {ttl} minutes.", { ttl })
        : minutes === 1 ? t("Computed 1 minute ago; results are reused for up to {ttl} minutes.", { ttl })
        : t("Computed {minutes} minutes ago; results are reused for up to {ttl} minutes.", { minutes, ttl })}{" "}
      <Link className="underline" href={`${path}?${q}`}>{t("Refresh now")}</Link>
    </p>
  );
}
