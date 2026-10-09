import Link from "next/link";
import { getT } from "@/i18n/server";
import { msg } from "@/i18n/translate";

export const RETENTION_TABS = [
  ["/retention", msg("Retention curves")],
  ["/churn", msg("Churn")],
  ["/rfm", msg("RFM segments")],
] as const;

/** The Retention section's pages as tabs (the side menu lists them too). `base` is /o/{org}/apps/{app}/analytics. */
export async function RetentionTabs({ base, current, env }: { base: string; current: (typeof RETENTION_TABS)[number][0]; env: string }) {
  const t = await getT();
  return (
    <nav className="flex flex-wrap gap-2 text-sm" aria-label={t("Retention")}>
      {RETENTION_TABS.map(([path, label]) => (
        <Link key={path} href={`${base}${path}?env=${env}`} aria-current={path === current ? "page" : undefined}
          className={`pill min-h-9 px-3 ${path === current ? "border-ink bg-ink text-paper" : "border-line hover:border-line-strong"}`}>{t(label)}</Link>
      ))}
    </nav>
  );
}
