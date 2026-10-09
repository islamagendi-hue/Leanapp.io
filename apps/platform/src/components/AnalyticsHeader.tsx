import { Fragment, type ReactNode } from "react";
import { getT } from "@/i18n/server";
import { msg } from "@/i18n/translate";

/** Environment types as they read inside a sentence (lowercase in English). */
const ENV_NAMES: Record<string, string> = { development: msg("development"), staging: msg("staging"), production: msg("production") };

/** An environment type for display ("production"), in the reader's language. */
export const envName = (t: (s: string) => string, env: string) => t(ENV_NAMES[env] ?? env);

/**
 * A translated sentence with markup in it: `{name}` placeholders are replaced
 * by the given nodes: rich(translated, { env: <strong>…</strong> }).
 */
export function rich(text: string, parts: Record<string, ReactNode>): ReactNode {
  return text.split(/(\{\w+\})/).map((s, i) => {
    const k = /^\{(\w+)\}$/.exec(s)?.[1];
    return <Fragment key={i}>{k && k in parts ? parts[k] : s}</Fragment>;
  });
}

/** Title and a reminder when the report isn't on production data (the environment is chosen in the top bar). */
export async function AnalyticsHeader({
  title, description, env,
}: {
  title: string;
  description: string;
  env: string;
}) {
  const t = await getT();
  return (
    <div className="space-y-3">
      <div>
        <h1 className="h1">{title}</h1>
        <p className="mt-1 max-w-2xl text-ink-2">{description}</p>
      </div>
      {env !== "production" && (
        <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
          {rich(t("Showing {env} data. Production reports never include it."), { env: <strong>{envName(t, env)}</strong> })}
        </p>
      )}
    </div>
  );
}

export const RANGE_LABELS: Record<number, string> = { 7: msg("Last 7 days"), 15: msg("Last 15 days"), 30: msg("Last 30 days"), 90: msg("Last 90 days") };

/** First value of a search param. */
export const param = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
