import { withSystem } from "@/lib/db";
import { checkConfig } from "@/server/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Liveness, configuration and database reachability. No tenant data; config
 * problems are reported by variable name only, never by value.
 */
export async function GET() {
  const started = Date.now();
  const config = checkConfig();
  const configBody = {
    deployment: config.deployment,
    errors: config.errors.map((e) => `${e.variable}: ${e.problem}`),
    warnings: config.warnings.map((w) => `${w.variable}: ${w.problem}`),
  };
  let database: "ok" | "unreachable" = "ok";
  try {
    await withSystem((db) => db.query("select 1"));
  } catch {
    database = "unreachable";
  }
  const ok = database === "ok" && config.errors.length === 0;
  return Response.json(
    { status: ok ? "ok" : "degraded", database, config: configBody, latency_ms: Date.now() - started },
    { status: ok ? 200 : 503 },
  );
}
