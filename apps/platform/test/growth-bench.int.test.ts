/**
 * Processing cost of the growth model (opt-in: GROWTH_BENCH=1, it takes a few
 * minutes). The same 20,000 events are processed for an app with the growth
 * model off and one with it on; the acceptance bound is +20% wall time.
 */
import { describe, expect, it } from "vitest";
import { withSystem } from "@/lib/db";
import { processPendingEvents } from "@/modules/processing/processor";
import { setGrowthModel } from "@/modules/growth/service";
import { makeTenant } from "./helpers";

const N = Number(process.env.GROWTH_BENCH_EVENTS ?? 20_000);

async function seed(t: Awaited<ReturnType<typeof makeTenant>>) {
  // 2,000 people, each with ~10 events over 60 days; a third identified. Inserted unprocessed.
  await withSystem((db) =>
    db.query(
      `insert into platform.events (organization_id, app_id, environment_id, event_id, type, event_name, "timestamp", anonymous_id, user_id, source, properties)
       select $1, $2, $3, 'bench-' || g, 'track',
              (array['app_opened', 'item_viewed', 'signup_completed', 'order_completed'])[1 + g % 4],
              now() - (g % 60) * interval '1 day' - (g % 977) * interval '1 minute',
              'bench-install-' || (g % 2000),
              case when g % 3 = 0 then 'bench-user-' || (g % 2000) end,
              'mobile_sdk', jsonb_build_object('revenue', (g % 50) + 0.5, 'currency', 'SAR')
         from generate_series(1, $4) g`,
      [t.org.id, t.app.id, t.dev.id, N],
    ),
  );
}

async function timed() {
  const started = performance.now();
  let total = 0;
  for (;;) {
    const r = await processPendingEvents({ limit: 20_000 });
    total += r.processed + r.failed;
    if (!r.processed && !r.failed) break;
  }
  return { ms: performance.now() - started, total };
}

describe.skipIf(!process.env.GROWTH_BENCH)("growth model processing cost", () => {
  it(`processes ${N} events with the growth model on within +20% of off`, async () => {
    const off = await makeTenant("bench-off");
    const on = await makeTenant("bench-on");
    await setGrowthModel(on.ctx, on.app.id, true);
    await withSystem((db) => db.query("delete from platform.app_reprocess_jobs where app_id = $1", [on.app.id]));
    await seed(off);
    const a = await timed();
    await seed(on);
    const b = await timed();
    // A second fresh "off" app after it, so table growth and caches affect both sides alike.
    const off2 = await makeTenant("bench-off-2");
    await seed(off2);
    const a2 = await timed();
    const base = (a.ms + a2.ms) / 2;
    console.log(JSON.stringify({ events: N, off_ms: Math.round(a.ms), off_after_ms: Math.round(a2.ms), on_ms: Math.round(b.ms), ratio: +(b.ms / base).toFixed(3) }));
    expect(a.total).toBe(N);
    expect(b.total).toBe(N);
    expect(b.ms / base).toBeLessThan(1.2);
  }, 900_000);
});
