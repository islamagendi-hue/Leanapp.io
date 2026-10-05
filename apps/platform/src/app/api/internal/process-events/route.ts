import { timingSafeEqual } from "node:crypto";
import { purgeRateLimitBuckets } from "@/lib/rate-limit";
import { processPendingEvents } from "@/modules/processing/processor";

export const runtime = "nodejs";
export const maxDuration = 60;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const given = req.headers.get("authorization")?.replace(/^Bearer /i, "") ?? "";
  if (!secret || given.length !== secret.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(secret));
}

/** Scheduled safety net: drains events the after() hook missed and purges old rate-limit windows. */
export async function GET(req: Request) {
  if (!authorized(req)) return new Response("Unauthorized", { status: 401 });
  let processed = 0;
  let failed = 0;
  for (let i = 0; i < 10; i++) {
    const r = await processPendingEvents({ limit: 1000 });
    processed += r.processed;
    failed += r.failed;
    if (r.processed + r.failed < 1000) break;
  }
  const purged = await purgeRateLimitBuckets();
  return Response.json({ processed, failed, purged });
}
