import "server-only";
import { createHash } from "node:crypto";
import { withSystem, type Db } from "@/lib/db";
import { log } from "@/lib/log";
import { effectiveConsent, loadStateRows, userKeysOf } from "@/modules/privacy/consent";
import { applyAdServicesAttribution } from "./engine";

/**
 * Apple Search Ads attribution through Apple's AdServices framework.
 *
 * The iOS SDK reads AAAttribution.attributionToken() (iOS 14.3+) once and
 * sends it as context.attribution.adservices_token. The scheduled worker:
 *   1. queueAdServicesTokens   scans newly stored events for that key and
 *                              queues one lookup per token (deduplicated by hash)
 *   2. processAdServicesLookups posts each token to Apple's AdServices API and
 *                              stores Apple's answer in adservices_attributions
 *
 *   POST https://api-adservices.apple.com/api/v1/   Content-Type: text/plain, body = token
 *     200  JSON: { attribution: true, orgId, campaignId, adGroupId, keywordId, adId,
 *          countryOrRegion, conversionType, claimType?, clickDate? } or { attribution: false }
 *     404  token not found yet: Apple asks to retry (it says within 5-second steps;
 *          this worker retries on its next runs, until the token's 24 hours are up)
 *     400  invalid token: final
 *     5xx  Apple error: retried
 *
 * No credentials are involved: the token itself authorizes the lookup. It is
 * kept only until the lookup is final, then cleared. Users who denied the
 * `attribution` consent purpose are never looked up.
 *
 * This is a data source: it stores what Apple reports (evidence level
 * provider_reported). An "attributed" answer is then handed to the attribution
 * engine (applyAdServicesAttribution in ./engine.ts), which decides what it
 * changes: an unattributed install becomes provider-reported Apple Search Ads.
 * The client follows Apple's published documentation and is NOT VERIFIED
 * against the live API from this codebase (tests use a fake fetch).
 * Operators can turn lookups off with APPLE_ADSERVICES_LOOKUP=off.
 */
export const ADSERVICES_URL = "https://api-adservices.apple.com/api/v1/";
/** Apple accepts a token for 24 hours after it is created. */
export const TOKEN_TTL_HOURS = 24;
/** Wait after the n-th unsuccessful try (404 / 5xx / network); the 24-hour limit ends it sooner if reached. */
const RETRY_SECONDS = [60, 300, 900, 3_600, 3 * 3_600, 6 * 3_600];
const LEASE_SECONDS = 120;
const TIMEOUT_MS = 10_000;
/** Events read per scan run. */
const SCAN_BATCH = 5_000;
/** Events newer than this are left for the next run, so a slower concurrent insert with a lower id isn't skipped. */
const SCAN_SETTLE_SECONDS = 120;

export interface AdServicesResult {
  attribution: boolean;
  orgId: number | null;
  campaignId: number | null;
  adGroupId: number | null;
  keywordId: number | null;
  adId: number | null;
  countryOrRegion: string | null;
  conversionType: string | null;
  claimType: string | null;
  clickDate: string | null;
}

export type LookupOutcome =
  | { kind: "answer"; status: number; result: AdServicesResult; raw: Record<string, unknown> }
  | { kind: "retry"; status: number | null; error: string }
  | { kind: "failed"; status: number | null; error: string };

export const tokenHash = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

/** Shape check only (Apple's tokens are base64 text); never logged. */
export function plausibleToken(token: unknown): token is string {
  return typeof token === "string" && token.length >= 16 && token.length <= 10_000 && /^[A-Za-z0-9+/=_-]+$/.test(token);
}

const int = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) ? v : typeof v === "string" && /^\d{1,18}$/.test(v) ? Number(v) : null);
const text = (v: unknown, max = 100) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/** Apple's 200 body, or null when it isn't the documented shape. */
export function parseAdServicesResponse(body: unknown): AdServicesResult | null {
  if (!body || typeof body !== "object" || typeof (body as { attribution?: unknown }).attribution !== "boolean") return null;
  const b = body as Record<string, unknown>;
  const attribution = b.attribution === true;
  const clickDate = text(b.clickDate, 40);
  return {
    attribution,
    orgId: attribution ? int(b.orgId) : null,
    campaignId: attribution ? int(b.campaignId) : null,
    adGroupId: attribution ? int(b.adGroupId) : null,
    keywordId: attribution ? int(b.keywordId) : null,
    adId: attribution ? int(b.adId) : null,
    countryOrRegion: attribution ? text(b.countryOrRegion, 10) : null,
    conversionType: attribution ? text(b.conversionType, 40) : null,
    claimType: attribution ? text(b.claimType, 40) : null,
    clickDate: attribution && clickDate && !Number.isNaN(Date.parse(clickDate)) ? clickDate : null,
  };
}

/** One call to Apple's AdServices API. Never throws; never includes the token in errors. */
export async function lookupAdServicesToken(token: string, fetchImpl: typeof fetch = fetch): Promise<LookupOutcome> {
  if (!plausibleToken(token)) return { kind: "failed", status: null, error: "not an AdServices token" };
  let res: Response;
  try {
    res = await fetchImpl(ADSERVICES_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: token,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const e = err as Error;
    return { kind: "retry", status: null, error: e.name === "TimeoutError" ? "timed out" : "request failed" };
  }
  const status = res.status;
  if (status === 200) {
    const raw = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const result = parseAdServicesResponse(raw);
    return result && raw ? { kind: "answer", status, result, raw } : { kind: "failed", status, error: "unreadable response from Apple" };
  }
  await res.body?.cancel().catch(() => {});
  if (status === 404) return { kind: "retry", status, error: "token not found yet (Apple asks to retry)" };
  if (status === 400) return { kind: "failed", status, error: "Apple rejected the token as invalid" };
  if (status === 429 || status >= 500) return { kind: "retry", status, error: `Apple returned HTTP ${status}` };
  return { kind: "failed", status, error: `Apple returned HTTP ${status}` };
}

/** Delay before the next try after `attempts` tries, or null to give up. */
export function retryDelaySeconds(attempts: number): number | null {
  return attempts >= 1 && attempts <= RETRY_SECONDS.length ? RETRY_SECONDS[attempts - 1] : null;
}

export const lookupsEnabled = () => (process.env.APPLE_ADSERVICES_LOOKUP ?? "").trim().toLowerCase() !== "off";

// ── Queueing ──────────────────────────────────────────────────────────────
/**
 * Reads events stored since the last run (by id, in batches) and queues a
 * lookup for each AdServices token. Tokens older than 24 hours are stored as
 * expired without a call. Idempotent: a token is queued once per environment.
 */
export async function queueAdServicesTokens(opts: { batch?: number } = {}): Promise<{ scanned: number; queued: number }> {
  return withSystem(async (db) => {
    const state = await db.one<{ last_event_id: string }>("select last_event_id::text from platform.adservices_scan_state where id for update");
    if (!state) return { scanned: 0, queued: 0 };
    const rows = await db.query<{ id: string; recent: boolean; organization_id: string; app_id: string; environment_id: string; anonymous_id: string | null; user_id: string | null; timestamp: Date; received_at: Date; token: string | null }>(
      `select id::text, received_at > now() - make_interval(secs => $3) as recent, organization_id, app_id, environment_id, anonymous_id, user_id, "timestamp", received_at,
              case when context->'attribution' ? 'adservices_token' then context->'attribution'->>'adservices_token' end as token
         from platform.events where id > $1::bigint order by id limit $2`,
      [state.last_event_id, opts.batch ?? SCAN_BATCH, SCAN_SETTLE_SECONDS],
    );
    let upto = state.last_event_id;
    let queued = 0;
    let scanned = 0;
    for (const r of rows) {
      if (r.recent) break;
      upto = r.id;
      scanned++;
      if (!r.token || !plausibleToken(r.token)) continue;
      // The token is minted on the device shortly before the event; the event's own time bounds its age.
      const mintedAt = new Date(Math.min(new Date(r.timestamp).getTime(), new Date(r.received_at).getTime()));
      const expired = Date.now() - mintedAt.getTime() > TOKEN_TTL_HOURS * 3_600_000;
      const row = await db.one(
        `insert into platform.adservices_attributions (organization_id, app_id, environment_id, anonymous_id, user_id, event_row_id, token_hash, token, token_received_at, status)
         values ($1, $2, $3, $4, $5, $6::bigint, $7, $8, $9, $10)
         on conflict (environment_id, token_hash) do nothing returning id`,
        [r.organization_id, r.app_id, r.environment_id, r.anonymous_id, r.user_id, r.id, tokenHash(r.token), expired ? null : r.token, mintedAt, expired ? "expired" : "pending"],
      );
      if (row && !expired) queued++;
    }
    if (upto !== state.last_event_id) await db.query("update platform.adservices_scan_state set last_event_id = $1::bigint, updated_at = now() where id", [upto]);
    return { scanned, queued };
  });
}

// ── Lookups ───────────────────────────────────────────────────────────────
interface Due {
  id: string;
  environment_id: string;
  anonymous_id: string | null;
  user_id: string | null;
  token: string | null;
  token_received_at: Date;
  attempts: number;
}

export interface LookupRunResult {
  attributed: number;
  notAttributed: number;
  retrying: number;
  failed: number;
  expired: number;
  skipped: number;
}

/** Posts due tokens to Apple and stores the answers. Claimed with SKIP LOCKED and leased, like postback delivery. */
export async function processAdServicesLookups(opts: { limit?: number; deadline?: number; fetchImpl?: typeof fetch } = {}): Promise<LookupRunResult> {
  const out: LookupRunResult = { attributed: 0, notAttributed: 0, retrying: 0, failed: 0, expired: 0, skipped: 0 };
  const due = await withSystem((db) =>
    db.query<Due>(
      `with due as (
         select id from platform.adservices_attributions
          where status = 'pending' and next_attempt_at <= now()
          order by next_attempt_at limit $1 for update skip locked)
       update platform.adservices_attributions a set attempts = a.attempts + 1, next_attempt_at = now() + make_interval(secs => $2)
         from due where a.id = due.id
       returning a.id, a.environment_id, a.anonymous_id, a.user_id, a.token, a.token_received_at, a.attempts`,
      [Math.min(opts.limit ?? 100, 500), LEASE_SECONDS],
    ),
  );
  for (const d of due) {
    if (opts.deadline && Date.now() >= opts.deadline) break; // the lease expires and the next run picks it up
    const final = (db: Db, status: string, extra: { skip_reason?: string; error?: string | null; code?: number | null; looked?: boolean } = {}) =>
      db.query(
        `update platform.adservices_attributions set status = $2, token = null, skip_reason = $3, last_error = $4, last_status_code = coalesce($5, last_status_code),
                looked_up_at = case when $6 then now() else looked_up_at end where id = $1`,
        [d.id, status, extra.skip_reason ?? null, extra.error ?? null, extra.code ?? null, extra.looked ?? false],
      );
    if (!d.token || Date.now() - new Date(d.token_received_at).getTime() > TOKEN_TTL_HOURS * 3_600_000) {
      await withSystem((db) => final(db, "expired", { error: "token older than 24 hours" }));
      out.expired++;
      continue;
    }
    const keys = userKeysOf({ userId: d.user_id, anonymousId: d.anonymous_id });
    const consent = keys.length ? effectiveConsent(await withSystem((db) => loadStateRows(db, d.environment_id, keys, ["attribution"])), keys, "attribution") : null;
    if (consent === false) {
      await withSystem((db) => final(db, "skipped", { skip_reason: "consent_denied" }));
      out.skipped++;
      continue;
    }
    const r = await lookupAdServicesToken(d.token, opts.fetchImpl ?? fetch);
    if (r.kind === "answer") {
      const a = r.result;
      await withSystem((db) =>
        db.query(
          `update platform.adservices_attributions
              set status = $2, token = null, last_status_code = $3, last_error = null, looked_up_at = now(),
                  apple_org_id = $4, campaign_id = $5, ad_group_id = $6, keyword_id = $7, ad_id = $8, country_or_region = $9,
                  conversion_type = $10, claim_type = $11, click_date = $12, raw = $13
            where id = $1`,
          [d.id, a.attribution ? "attributed" : "not_attributed", r.status, a.orgId, a.campaignId, a.adGroupId, a.keywordId, a.adId, a.countryOrRegion,
           a.conversionType, a.claimType, a.clickDate, JSON.stringify(r.raw)],
        ),
      );
      if (a.attribution) {
        out.attributed++;
        // The answer is stored either way; a failure to apply it is logged, never loses the answer.
        try {
          await withSystem((db) => applyAdServicesAttribution(db, d.id));
        } catch (err) {
          log.error("attribution.adservices_apply_failed", { lookup_id: d.id, error: String((err as Error).message).slice(0, 300) });
        }
      } else out.notAttributed++;
      continue;
    }
    const delay = r.kind === "retry" ? retryDelaySeconds(d.attempts) : null;
    const tooOld = delay !== null && new Date(d.token_received_at).getTime() + TOKEN_TTL_HOURS * 3_600_000 < Date.now() + delay * 1000;
    if (r.kind === "retry" && delay !== null && !tooOld) {
      await withSystem((db) =>
        db.query(
          `update platform.adservices_attributions set last_status_code = $2, last_error = $3, next_attempt_at = now() + make_interval(secs => $4),
                  looked_up_at = case when $2::int is null then looked_up_at else now() end where id = $1`,
          [d.id, r.status, r.error, delay],
        ),
      );
      out.retrying++;
    } else {
      await withSystem((db) => final(db, r.kind === "retry" ? "expired" : "failed", { error: r.error, code: r.status, looked: r.status !== null }));
      if (r.kind === "retry") out.expired++;
      else {
        out.failed++;
        log.warn("attribution.adservices_failed", { lookup_id: d.id, status: r.status, error: r.error });
      }
    }
  }
  return out;
}

/** The scheduled AdServices work: queue new tokens, then look up due ones. */
export async function runAdServicesJobs(opts: { deadline?: number; fetchImpl?: typeof fetch } = {}): Promise<(LookupRunResult & { queued: number }) | { disabled: true }> {
  if (!lookupsEnabled()) return { disabled: true };
  const { queued } = await queueAdServicesTokens();
  return { queued, ...(await processAdServicesLookups(opts)) };
}

// ── Reads ─────────────────────────────────────────────────────────────────
export interface AdServicesAttribution {
  status: "pending" | "attributed" | "not_attributed" | "failed" | "expired" | "skipped";
  appleOrgId: number | null;
  campaignId: number | null;
  adGroupId: number | null;
  keywordId: number | null;
  adId: number | null;
  countryOrRegion: string | null;
  conversionType: string | null;
  claimType: string | null;
  clickDate: Date | null;
  lookedUpAt: Date | null;
}

/**
 * Apple's latest answer for an install (by anonymous id), for the attribution
 * engine to use as provider-reported evidence. Null when no token was received.
 */
export async function adServicesAttributionFor(db: Db, environmentId: string, anonymousId: string): Promise<AdServicesAttribution | null> {
  const r = await db.one<{ status: AdServicesAttribution["status"]; apple_org_id: string | null; campaign_id: string | null; ad_group_id: string | null; keyword_id: string | null; ad_id: string | null;
    country_or_region: string | null; conversion_type: string | null; claim_type: string | null; click_date: Date | null; looked_up_at: Date | null }>(
    `select status, apple_org_id::text, campaign_id::text, ad_group_id::text, keyword_id::text, ad_id::text, country_or_region, conversion_type, claim_type, click_date, looked_up_at
       from platform.adservices_attributions where environment_id = $1 and anonymous_id = $2
      order by (status = 'attributed') desc, created_at desc limit 1`,
    [environmentId, anonymousId],
  );
  if (!r) return null;
  const n = (v: string | null) => (v === null ? null : Number(v));
  return {
    status: r.status, appleOrgId: n(r.apple_org_id), campaignId: n(r.campaign_id), adGroupId: n(r.ad_group_id), keywordId: n(r.keyword_id), adId: n(r.ad_id),
    countryOrRegion: r.country_or_region, conversionType: r.conversion_type, claimType: r.claim_type, clickDate: r.click_date, lookedUpAt: r.looked_up_at,
  };
}

/** Lookup activity of one environment over 30 days, for the Integrations Center (tenant scope is fine: no token column). */
export async function adServicesStats(db: Db, environmentId: string): Promise<{ total: number; attributed: number; lastAnswerAt: Date | null; lastFailureAt: Date | null; lastError: string | null }> {
  const r = await db.one<{ total: string; attributed: string; last_answer_at: Date | null; last_failure_at: Date | null; last_error: string | null }>(
    `select count(*) as total, count(*) filter (where status = 'attributed') as attributed,
            max(looked_up_at) filter (where status in ('attributed', 'not_attributed')) as last_answer_at,
            max(looked_up_at) filter (where status = 'failed' or (status = 'pending' and last_status_code is not null and last_status_code <> 404)) as last_failure_at,
            (select last_error from platform.adservices_attributions where environment_id = $1 and status = 'failed' order by updated_at desc limit 1) as last_error
       from platform.adservices_attributions where environment_id = $1 and created_at > now() - interval '30 days'`,
    [environmentId],
  );
  return { total: Number(r?.total ?? 0), attributed: Number(r?.attributed ?? 0), lastAnswerAt: r?.last_answer_at ?? null, lastFailureAt: r?.last_failure_at ?? null, lastError: r?.last_error ?? null };
}
