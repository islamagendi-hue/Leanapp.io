import Link from "next/link";
import { getT } from "@/i18n/server";
import { msg, type T } from "@/i18n/translate";

const ENV_NAMES: Record<string, string> = { development: msg("development"), staging: msg("staging"), production: msg("production") };

/** An environment type as it reads inside a sentence ("development" in English). */
export const envName = (env: string, t: T) => t(ENV_NAMES[env] ?? env);

/** Which environment a dashboard shows, and a link to recompute its widgets now. */
export async function EnvironmentNote({ env, refresh }: { env: string; refresh: string }) {
  const t = await getT();
  const [before, after] = t("Showing {env} data.", { env: "\u0000" }).split("\u0000");
  return (
    <p className="text-xs text-ink-3">
      {before}<strong>{envName(env, t)}</strong>{after} {t("Results may be up to 10 minutes old.")} <Link className="underline" href={refresh}>{t("Refresh now")}</Link>
    </p>
  );
}
