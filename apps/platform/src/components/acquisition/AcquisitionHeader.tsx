import Link from "next/link";
import { AutoApply } from "@/components/AutoApply";
import { getT } from "@/i18n/server";
import { msg } from "@/i18n/translate";
import { RANGES } from "@/modules/analytics/range";
import { envName, rich } from "./rich";

export const ACQUISITION_TABS = [
  ["", msg("Overview")],
  ["/sources", msg("Sources & campaigns")],
  ["/attribution", msg("Attribution")],
  ["/links", msg("Tracking links & QR")],
  ["/deep-links", msg("Deep links")],
] as const;

/**
 * Header of every Acquisition page: title, the Beta label with what
 * Acquisition is (and isn't), the section tabs, and the environment notice.
 * `title` and `description` come translated.
 */
export async function AcquisitionHeader({ base, current, title, description, env }: {
  /** /o/{org}/apps/{app}/acquisition */
  base: string;
  current: (typeof ACQUISITION_TABS)[number][0];
  title: string;
  description: string;
  env: string;
}) {
  const t = await getT();
  return (
    <div className="space-y-3">
      <div>
        <h1 className="h1">{title} <span className="pill border-warn/40 bg-warn-soft align-middle text-xs text-warn">{t("Beta")}</span></h1>
        <p className="mt-1 max-w-3xl text-ink-2">{description}</p>
      </div>
      <nav className="flex flex-wrap gap-2 text-sm" aria-label={t("Acquisition")}>
        {ACQUISITION_TABS.map(([path, label]) => (
          <Link key={path} href={`${base}${path}?env=${env}`} aria-current={path === current ? "page" : undefined}
            className={`pill ${path === current ? "border-ink bg-ink text-paper" : "border-line hover:border-line-strong"}`}>{t(label)}</Link>
        ))}
      </nav>
      <details className="max-w-3xl rounded-lg border border-line px-3 py-2 text-sm text-ink-2">
        <summary className="cursor-pointer font-medium">{t("What Acquisition (Beta) measures")}</summary>
        <p className="mt-2">
          {t("Installs and re-engagements are matched from LeanApp's own event stream: clicks on LeanApp tracking links, the store install referrer and the ad-network click ids your app sends. Each conversion is credited to the last touch before it. Apple's SKAdNetwork postbacks appear separately, in aggregate only, and are never tied to a user.")}
        </p>
        <p className="mt-2">
          {t("It is not a full mobile measurement partner: there is no ad cost import or ROAS, no fraud prevention, no multi-touch or view-through attribution, and no installs reported by ad networks themselves. Numbers can differ from what ad networks report.")}
        </p>
      </details>
      {env !== "production" && (
        <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">{rich(t("Showing {env} data. Use production links in live campaigns."), { env: <strong>{envName(t, env)}</strong> })}</p>
      )}
    </div>
  );
}

/**
 * The range picker of the Acquisition reports: the last 7, 15, 30 or 90 days,
 * or custom dates. It applies as soon as it changes (AutoApply).
 */
export async function AcquisitionRange({ env, range }: { env: string; range: { preset: number | null; from: string; to: string } }) {
  const t = await getT();
  return (
    <form method="get" className="flex flex-wrap items-end gap-3" aria-label={t("Range")}>
      <input type="hidden" name="env" value={env} />
      <AutoApply />
      <label><span className="label">{t("Range")}</span>
        <select name="days" className="input" defaultValue={range.preset ? String(range.preset) : "custom"}>
          {RANGES.map((d) => <option key={d} value={d}>{t("Last {n} days", { n: d })}</option>)}
          <option value="custom">{t("Custom dates")}</option>
        </select>
      </label>
      <label className="custom-date"><span className="label">{t("From")}</span><input type="date" name="from" className="input" defaultValue={range.from} /></label>
      <label className="custom-date"><span className="label">{t("To")}</span><input type="date" name="to" className="input" defaultValue={range.to} /></label>
      <button className="btn" type="submit" data-apply>{t("Show")}</button>
    </form>
  );
}

export const num = (n: number) => n.toLocaleString("en-US");
export const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "–");
export const money = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 2 });
