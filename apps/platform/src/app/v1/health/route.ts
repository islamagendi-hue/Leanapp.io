import { withSystem } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Liveness + database reachability. No tenant data. */
export async function GET() {
  const started = Date.now();
  try {
    await withSystem((db) => db.query("select 1"));
    return Response.json({ status: "ok", database: "ok", latency_ms: Date.now() - started });
  } catch {
    return Response.json({ status: "degraded", database: "unreachable" }, { status: 503 });
  }
}
