import Link from "next/link";
import { REPORT_CACHE_TTL_SECONDS } from "@/modules/analytics/cache";
import type { FreshnessInfo } from "@/server/analytics-page";

/** "Computed 4 min ago · Refresh" under a report that was served from the result cache. */
export function ReportFreshness({ info, path, sp }: { info: FreshnessInfo; path: string; sp: Record<string, string | string[] | undefined> }) {
  if (!info.fromCache || !info.computedAt) return null;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (k === "fresh" || v === undefined) continue;
    for (const x of Array.isArray(v) ? v : [v]) q.append(k, x);
  }
  q.set("fresh", "1");
  const minutes = info.ageMinutes;
  return (
    <p className="text-xs text-ink-3">
      Computed {minutes === 0 ? "less than a minute" : minutes === 1 ? "1 minute" : `${minutes} minutes`} ago; results are reused for up to {REPORT_CACHE_TTL_SECONDS / 60} minutes.{" "}
      <Link className="underline" href={`${path}?${q}`}>Refresh now</Link>
    </p>
  );
}
