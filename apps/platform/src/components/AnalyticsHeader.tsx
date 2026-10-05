import { EnvSwitcher } from "@/components/EnvSwitcher";

/** Title, environment tabs and a reminder when the report isn't on production data. */
export function AnalyticsHeader({
  title, description, path, env, query,
}: {
  title: string;
  description: string;
  path: string;
  env: string;
  query: Record<string, string | string[] | undefined>;
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="h1">{title}</h1>
          <p className="mt-1 max-w-2xl text-ink-2">{description}</p>
        </div>
        <EnvSwitcher path={path} current={env} query={query} />
      </div>
      {env !== "production" && (
        <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
          Showing <strong>{env}</strong> data. Production reports never include it.
        </p>
      )}
    </div>
  );
}

export const RANGE_LABELS: Record<number, string> = { 7: "Last 7 days", 30: "Last 30 days", 90: "Last 90 days" };

/** First value of a search param. */
export const param = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
