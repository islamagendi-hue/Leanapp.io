import Link from "next/link";

export const ACQUISITION_TABS = [
  ["", "Overview"],
  ["/sources", "Sources & campaigns"],
  ["/attribution", "Attribution"],
  ["/links", "Tracking links & QR"],
  ["/deep-links", "Deep links"],
] as const;

/**
 * Header of every Acquisition page: title, the Beta label with what
 * Acquisition is (and isn't), the section tabs, and the environment notice.
 */
export function AcquisitionHeader({ base, current, title, description, env }: {
  /** /o/{org}/apps/{app}/acquisition */
  base: string;
  current: (typeof ACQUISITION_TABS)[number][0];
  title: string;
  description: string;
  env: string;
}) {
  return (
    <div className="space-y-3">
      <div>
        <h1 className="h1">{title} <span className="pill border-warn/40 bg-warn-soft align-middle text-xs text-warn">Beta</span></h1>
        <p className="mt-1 max-w-3xl text-ink-2">{description}</p>
      </div>
      <nav className="flex flex-wrap gap-2 text-sm" aria-label="Acquisition">
        {ACQUISITION_TABS.map(([path, label]) => (
          <Link key={path} href={`${base}${path}?env=${env}`} aria-current={path === current ? "page" : undefined}
            className={`pill ${path === current ? "border-ink bg-ink text-paper" : "border-line hover:border-line-strong"}`}>{label}</Link>
        ))}
      </nav>
      <details className="max-w-3xl rounded-lg border border-line px-3 py-2 text-sm text-ink-2">
        <summary className="cursor-pointer font-medium">What Acquisition (Beta) measures</summary>
        <p className="mt-2">
          Installs and re-engagements are matched from LeanApp&apos;s own event stream: clicks on LeanApp tracking links, the store install referrer and ad-network click ids
          your app sends. Each conversion is credited to the last touch before it. Apple&apos;s SKAdNetwork postbacks are shown separately, in aggregate.
        </p>
        <p className="mt-2">
          It is not a full mobile measurement partner: there is no ad cost import or ROAS, no fraud prevention, no multi-touch or view-through attribution, and no
          installs reported by ad networks themselves. Numbers can differ from what ad networks report.
        </p>
      </details>
      {env !== "production" && (
        <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">Showing <strong>{env}</strong> data. Use production links in live campaigns.</p>
      )}
    </div>
  );
}

/** The 7 / 30 / 90-day range picker of the Acquisition reports. */
export function AcquisitionRange({ env, days, ranges }: { env: string; days: number; ranges: readonly number[] }) {
  return (
    <nav className="flex flex-wrap gap-2 text-sm" aria-label="Range">
      {ranges.map((d) => (
        <Link key={d} href={`?env=${env}&days=${d}`} aria-current={d === days ? "page" : undefined}
          className={`pill ${d === days ? "border-ink bg-ink text-paper" : "border-line hover:border-line-strong"}`}>Last {d} days</Link>
      ))}
    </nav>
  );
}

export const num = (n: number) => n.toLocaleString("en-US");
export const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "–");
export const money = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 2 });
