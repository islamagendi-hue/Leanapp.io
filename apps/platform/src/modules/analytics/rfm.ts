import "server-only";
import type { TenantContext } from "@/modules/tenancy/context";
import { PENDING_DELETION } from "@/modules/audiences/definition";
import { loadRevenueRules, NO_CURRENCY, revenueCtes } from "./revenue-sql";
import {
  rfmCustomersSql, rfmWindow, RFM_SEGMENTS, scoreCustomers, summarizeSegments,
  type RfmSegment, type RfmWindow, type ScoredCustomer, type SegmentSummary,
} from "./rfm-pure";
import { analyticsTx } from "./service";
import { COUNTED_EVENTS, Params, PERSON } from "./sql";

/**
 * RFM segments for one environment (Retention → RFM segments). Scoring and
 * the segment map are in ./rfm-pure.ts; purchases, refunds and currencies
 * follow the Revenue report (./revenue-sql.ts): nothing is converted, so the
 * page shows one currency at a time, by default the one with the most
 * customers. People with a privacy deletion in progress are left out, as the
 * audiences saved from a segment leave them out.
 */

/** How many customers each segment's table lists. */
export const SEGMENT_LIST = 25;

export interface RfmReport {
  window: RfmWindow;
  /** Currencies with customers in the window, most customers first. */
  currencies: { currency: string; customers: number }[];
  /** The currency shown; null when there are no customers. */
  currency: string | null;
  customers: number;
  /** Net revenue of all customers in the currency. */
  revenue: number;
  segments: SegmentSummary[];
  /** Each segment's customers with the most revenue first (up to SEGMENT_LIST). */
  people: Record<RfmSegment, ScoredCustomer[]>;
  /** Customers per R × FM cell, CELLS[r − 1][fm − 1]. */
  cells: number[][];
}

export async function rfmReport(ctx: TenantContext, scope: { environmentId: string }, input: { window?: unknown; currency?: unknown }): Promise<RfmReport> {
  const window = rfmWindow(input.window);
  const wanted = typeof input.currency === "string" ? input.currency : null;
  return analyticsTx(ctx, async (db) => {
    const rules = await loadRevenueRules(db, scope.environmentId);
    const p = new Params([scope.environmentId, window]);
    // The window counts from the database's now(), as the audience condition does.
    const ctes = `ev as (
        select coalesce(e.canonical_name, e.event_name) as name, ${PERSON.expr} as person, e."timestamp" as ts, e.id, e.platform, e.properties
          from platform.events e ${PERSON.join}
         where e.environment_id = $1 and ${COUNTED_EVENTS} and coalesce(e.user_id, e.anonymous_id) is not null
           and e."timestamp" >= now() - make_interval(days => $2::int)),
      ${revenueCtes(p, rules)}`;
    const currencies = await db.query<{ currency: string; customers: number }>(
      `with ${ctes}
       select currency, count(distinct person)::int as customers from tx where kind <> 'refund'
        group by currency order by customers desc, currency = '${NO_CURRENCY}', currency`,
      p.values,
    );
    const currency = currencies.find((c) => c.currency === wanted)?.currency ?? currencies[0]?.currency ?? null;
    const rows = currency
      ? await db.query<{ person: string; recency: number; frequency: number; monetary: number; pending: boolean }>(
          `with ${ctes}
           select person, recency, frequency, monetary::float8 as monetary, ${PENDING_DELETION("c")} as pending
             from (${rfmCustomersSql("tx", p.add(currency))}) c`,
          p.values,
        )
      : [];
    // Everyone is scored (as the audience condition scores them); people being deleted are then left out.
    const pending = new Set(rows.filter((r) => r.pending).map((r) => r.person));
    const scored = scoreCustomers(rows.map((r) => ({ person: r.person, recency: Number(r.recency), frequency: Number(r.frequency), monetary: Number(r.monetary) })))
      .filter((c) => !pending.has(c.person));
    const cells = [1, 2, 3, 4, 5].map(() => [0, 0, 0, 0, 0]);
    for (const c of scored) cells[c.r - 1][Math.floor((c.f + c.m + 1) / 2) - 1]++;
    const byRevenue = [...scored].sort((a, b) => b.monetary - a.monetary || a.recency - b.recency || a.person.localeCompare(b.person));
    const people = Object.fromEntries(RFM_SEGMENTS.map((s) => [s, byRevenue.filter((c) => c.segment === s).slice(0, SEGMENT_LIST)])) as Record<RfmSegment, ScoredCustomer[]>;
    return {
      window,
      currencies,
      currency,
      customers: scored.length,
      revenue: Math.round(scored.reduce((s, c) => s + c.monetary, 0) * 100) / 100,
      segments: summarizeSegments(scored),
      people,
      cells,
    };
  });
}
