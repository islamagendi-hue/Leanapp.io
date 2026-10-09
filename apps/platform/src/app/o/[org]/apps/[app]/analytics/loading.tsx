import { getT } from "@/i18n/server";

/**
 * Shown at once while an analytics report loads: the shape of a report page
 * (title, filters, key numbers and a chart) in placeholder blocks, so the
 * click answers right away instead of leaving the old page up.
 */
export default async function Loading() {
  const t = await getT();
  return (
    <div className="space-y-6" aria-busy="true">
      <p className="sr-only" role="status">{t("Loading…")}</p>
      <div aria-hidden className="space-y-3">
        <div className="skeleton h-8 w-48" />
        <div className="skeleton h-4 w-full max-w-md" />
      </div>
      <div aria-hidden className="skeleton h-16 w-full rounded-xl" />
      <div aria-hidden className="stat-grid">
        {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-24 rounded-xl" />)}
      </div>
      <div aria-hidden className="skeleton h-64 w-full rounded-xl" />
    </div>
  );
}
