import "server-only";
import { withSystem, type Db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { log } from "@/lib/log";
import { decryptSecret } from "@/lib/secret-box";
import { effectiveConsent, loadStateRows, userKeysOf, type StateRow } from "@/modules/privacy/consent";
import { runAdServicesJobs } from "./adservices";
import {
  actionSourceOf, eligibility, eventSourceUrl, hasWebEvents, metaBrowserId, parseProviderError, pixelCookieId, requestSummary, userDataAllowed, userDataMode, validateConversionBody,
  type ActionSource, type RawUserData, type SkipReason,
} from "./conversions";
import { buildRequest, googleAccessToken, type Network, type WebContext } from "./networks";
import { backoffSeconds, retryable, type PostbackPayload } from "./pure";
import { assertSafeDestination } from "./url-safety";

/**
 * Postback delivery (run from the scheduled worker). Deliveries are claimed
 * with FOR UPDATE SKIP LOCKED and leased by pushing next_attempt_at forward
 * before the HTTP call, so concurrent workers never send one twice. Results:
 * 2xx succeeded; network errors, 408/425/429/5xx (and provider "try later"
 * codes such as Meta's 17 sent with HTTP 400) retried with backoff
 * (1m, 5m, 30m, 2h, 12h) then giving_up; other statuses failed.
 *
 * Before sending (./conversions.ts): ad-network deliveries whose user or
 * install has denied the `attribution` consent purpose, that carry nothing
 * the network can match on, or whose body breaks the network's rules are
 * marked `skipped` with the reason, and never sent. Each attempt records the
 * provider's error code and trace id and a token-free summary of the request.
 *
 * Website events (Meta, TikTok, Snap) and hashed user data (Meta advanced
 * matching, TikTok / Snap website events, Google Enhanced Conversions) are
 * read at send time from the stored event behind the delivery and the user's
 * profile (loadSendContext): the page URL, user agent, the network's browser
 * cookie ids (Meta _fbp / _fbc, TikTok _ttp, Snap _scid), and the `email` /
 * `phone` user properties. None of it is copied onto the delivery row.
 */
const LEASE_SECONDS = 120;
const TIMEOUT_MS = 10_000;
/** How far back an earlier event of the same visitor may supply a browser cookie id (_fbp / _fbc, _ttp, _scid). Meta's _fbp cookie lives 90 days; the same bound is used for all. */
const BROWSER_ID_LOOKBACK_DAYS = 90;

interface Claimed {
  id: string;
  postback_id: string;
  organization_id: string;
  environment_id: string;
  attempts: number;
  payload: PostbackPayload;
  network: Network;
  url_template: string | null;
  http_method: "GET" | "POST";
  config: Record<string, string>;
  credentials_enc: string | null;
  attribution_event_id: string | null;
  conversion_id: string | null;
  anonymous_id: string | null;
  user_id: string | null;
}

interface SendContext {
  actionSource: ActionSource;
  web: WebContext | null;
  userData: RawUserData | null;
}

/** Each network's browser cookie ids in context.attribution (set by its own pixel; the web SDK only reads them). */
const BROWSER_ID_KEYS: Record<"meta" | "tiktok" | "snapchat", ("fbp" | "fbc" | "ttp" | "scid")[]> = {
  meta: ["fbp", "fbc"],
  tiktok: ["ttp"],
  snapchat: ["scid"],
};
const browserIdOf = (key: string, v: unknown) => (key === "fbp" || key === "fbc" ? metaBrowserId(v) : pixelCookieId(v));

const str = (v: unknown, max = 1000) => (typeof v === "string" && v.trim() && v.length <= max ? v.trim() : null);

/**
 * What a Meta / TikTok / Snap / Google request needs beyond the queued payload, read from the
 * event behind the delivery (the conversion's event, else the attribution
 * event's) and the user's profile. User data is only read when the postback
 * may send it (send_user_data and the user's consent).
 */
async function loadSendContext(db: Db, d: Claimed, attributionConsent: boolean | null): Promise<SendContext> {
  const ev = await db.one<{ event_id: string; platform: string | null; context: Record<string, unknown>; properties: Record<string, unknown>; anonymous_id: string | null; user_id: string | null; timestamp: Date }>(
    `select e.event_id, e.platform, e.context, e.properties, e.anonymous_id, e.user_id, e."timestamp"
       from platform.events e
      where e.environment_id = $1
        and e.id = coalesce((select c.event_row_id from platform.attribution_conversions c where c.id = $2),
                            (select a.event_row_id from platform.attribution_events a where a.id = $3))`,
    [d.environment_id, d.conversion_id, d.attribution_event_id],
  );
  const platform = ev?.platform ?? d.payload.platform ?? null;
  const actionSource: ActionSource = hasWebEvents(d.network) ? actionSourceOf(d.config.action_source, platform) : "app";
  let web: WebContext | null = null;
  if (hasWebEvents(d.network) && actionSource === "website" && ev) {
    const ctx = ev.context ?? {};
    const attr = (ctx.attribution ?? {}) as Record<string, unknown>;
    const page = (ctx.page ?? {}) as Record<string, unknown>;
    const props = ev.properties ?? {};
    // The network's own browser cookie ids, as the web SDK read them (context.attribution).
    const keys = BROWSER_ID_KEYS[d.network];
    const ids: Record<string, string | null> = {};
    for (const k of keys) ids[k] = browserIdOf(k, attr[k]);
    const anon = ev.anonymous_id ?? d.anonymous_id;
    const missing = keys.filter((k) => !ids[k]);
    if (missing.length && anon) {
      // The web SDK sends attribution context on a session's first event, not on every event.
      // Keys come from the fixed BROWSER_ID_KEYS list, never from input.
      const earlier = await db.one<Record<string, string | null>>(
        `select ${missing.map((k) => `(select context->'attribution'->>'${k}' from platform.events
                  where environment_id = $1 and anonymous_id = $2 and context->'attribution' ? '${k}'
                    and "timestamp" between $3::timestamptz - make_interval(days => $4) and $3::timestamptz + interval '5 minutes'
                  order by "timestamp" desc limit 1) as ${k}`).join(",\n                ")}`,
        [d.environment_id, anon, ev.timestamp, BROWSER_ID_LOOKBACK_DAYS],
      );
      for (const k of missing) ids[k] = browserIdOf(k, earlier?.[k]);
    }
    web = {
      eventId: ev.event_id,
      eventSourceUrl: eventSourceUrl(props.url) ?? eventSourceUrl(props.page_url) ?? eventSourceUrl(page.url) ?? eventSourceUrl(attr.landing_url),
      userAgent: str(ctx.user_agent) ?? str(ctx.userAgent),
      ...ids,
    };
  }
  let userData: RawUserData | null = null;
  const userId = ev?.user_id ?? d.user_id;
  // TikTok and Snap get hashed user data on website events only.
  const userDataApplies = d.network === "meta" || d.network === "google" || actionSource === "website";
  if (userDataApplies && userDataAllowed(userDataMode(d.config.send_user_data), attributionConsent) && userId) {
    const profile = await db.one<{ properties: Record<string, unknown> }>(
      "select properties from platform.app_users where environment_id = $1 and external_id = $2",
      [d.environment_id, userId],
    );
    userData = { email: profile?.properties?.email, phone: profile?.properties?.phone, externalId: userId };
  }
  return { actionSource, web, userData };
}

export async function deliverPostbacks(opts: { limit?: number; deadline?: number; fetchImpl?: typeof fetch } = {}): Promise<{ succeeded: number; retrying: number; failed: number; skipped: number }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const claimed = await withSystem((db) =>
    db.query<Claimed>(
      `with due as (
         select d.id from platform.attribution_postback_deliveries d
           join platform.attribution_postbacks p on p.id = d.postback_id and p.status = 'active'
          where d.status = 'pending' and d.next_attempt_at <= now()
          order by d.next_attempt_at limit $1
          for update of d skip locked)
       update platform.attribution_postback_deliveries d
          set attempts = d.attempts + 1, next_attempt_at = now() + make_interval(secs => $2)
         from due, platform.attribution_postbacks p
        where d.id = due.id and p.id = d.postback_id
       returning d.id, d.postback_id, d.organization_id, d.environment_id, d.attempts, d.payload, p.network, p.url_template, p.http_method, p.config, p.credentials_enc,
                 d.attribution_event_id, d.conversion_id,
                 (select ae.anonymous_id from platform.attribution_events ae where ae.id = d.attribution_event_id) as anonymous_id,
                 (select ae.user_id from platform.attribution_events ae where ae.id = d.attribution_event_id) as user_id`,
      [Math.min(opts.limit ?? 200, 1000), LEASE_SECONDS],
    ),
  );
  // Consent at send time, one lookup per environment.
  const consentRows = new Map<string, StateRow[]>();
  for (const envId of new Set(claimed.filter((d) => d.network !== "custom").map((d) => d.environment_id))) {
    const keys = [...new Set(claimed.filter((d) => d.environment_id === envId).flatMap((d) => userKeysOf({ userId: d.user_id, anonymousId: d.anonymous_id })))];
    consentRows.set(envId, keys.length ? await withSystem((db) => loadStateRows(db, envId, keys, ["attribution"])) : []);
  }

  const result = { succeeded: 0, retrying: 0, failed: 0, skipped: 0 };
  const googleTokens = new Map<string, Promise<string>>();
  for (const d of claimed) {
    if (opts.deadline && Date.now() >= opts.deadline) break; // the lease expires and the next run picks it up
    let status: number | null = null;
    let error: string | null = null;
    let permanent = false;
    let skip: SkipReason | null = null;
    let providerCode: string | null = null;
    let traceId: string | null = null;
    let providerRetry = false;
    let summary: Record<string, unknown> | null = null;
    let send: SendContext | null = null;
    let consent: boolean | null = null;
    try {
      if (d.network !== "custom") {
        const keys = userKeysOf({ userId: d.user_id, anonymousId: d.anonymous_id });
        consent = effectiveConsent(consentRows.get(d.environment_id) ?? [], keys, "attribution");
        if (consent !== false && (hasWebEvents(d.network) || d.network === "google")) send = await withSystem((db) => loadSendContext(db, d, consent));
        const match = send
          ? {
              actionSource: send.actionSource,
              browserIds: Boolean(send.web?.fbp || send.web?.fbc || send.web?.ttp || send.web?.scid),
              // Google's user identifiers are email and phone only; the others also match on the hashed user id.
              userData: Boolean(send.userData?.email || send.userData?.phone || (d.network !== "google" && send.userData?.externalId)),
            }
          : {};
        skip = eligibility(d.network, d.payload, { anonymousId: d.anonymous_id, userId: d.user_id }, consent, match);
      }
      if (!skip) {
        const credentials = d.credentials_enc ? (JSON.parse(decryptSecret(d.credentials_enc)) as Record<string, string>) : {};
        let accessToken: string | undefined;
        if (d.network === "google") {
          if (!googleTokens.has(d.postback_id)) googleTokens.set(d.postback_id, googleAccessToken(credentials, fetchImpl));
          accessToken = await googleTokens.get(d.postback_id);
        }
        const built = buildRequest(d.network, {
          urlTemplate: d.url_template, method: d.http_method, config: d.config, credentials, payload: d.payload, accessToken,
          anonymousId: d.network === "meta" ? d.anonymous_id : null,
          web: send?.web ?? null,
          userData: send?.userData ?? null,
          consentGranted: consent === true,
        });
        if (!built.ok) {
          error = built.error;
          permanent = true;
        } else {
          summary = requestSummary(built.request);
          const invalid = validateConversionBody(d.network, built.request.body);
          if (invalid) {
            skip = "invalid_payload";
            error = invalid;
          } else {
            await assertSafeDestination(built.request.url);
            const res = await fetchImpl(built.request.url, {
              method: built.request.method,
              headers: { "User-Agent": "LeanApp-Postback/1.0", ...built.request.headers },
              body: built.request.body,
              redirect: "manual",
              signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            status = res.status;
            if (status < 200 || status >= 300) {
              const text = (await res.text().catch(() => "")).slice(0, 2000);
              const info = parseProviderError(d.network, status, text);
              providerCode = info.code;
              traceId = info.traceId;
              providerRetry = info.retryable;
              error = `HTTP ${status}: ${(info.message ?? text).slice(0, 200)}`;
            } else await res.body?.cancel().catch(() => {});
          }
        }
      }
    } catch (err) {
      const e = err as Error & { code?: string };
      // Configuration problems (bad URL, missing key) won't fix themselves.
      permanent = err instanceof AppError || /INTEGRATIONS_ENCRYPTION_KEY|unrecognised secret|unable to authenticate/i.test(e.message);
      error = (e.name === "TimeoutError" ? "timed out" : e.message || "request failed").slice(0, 300);
    }
    const ok = !skip && status !== null && status >= 200 && status < 300;
    const canRetry = !skip && !ok && !permanent && (retryable(status) || providerRetry);
    const delay = canRetry ? backoffSeconds(d.attempts) : null;
    const next = skip ? "skipped" : ok ? "succeeded" : delay !== null ? "pending" : canRetry ? "giving_up" : "failed";
    await withSystem((db) =>
      db.query(
        `update platform.attribution_postback_deliveries
            set status = $2, last_status_code = $3, last_error = $4,
                next_attempt_at = case when $5::int is null then next_attempt_at else now() + make_interval(secs => $5::int) end,
                delivered_at = case when $2 = 'succeeded' then now() else delivered_at end,
                skip_reason = $6, provider_error_code = $7, provider_trace_id = $8, request_summary = coalesce($9::jsonb, request_summary)
          where id = $1`,
        [d.id, next, status, ok ? null : error ?? (skip ? skip : null), delay, skip, providerCode, traceId, summary ? JSON.stringify(summary) : null],
      ),
    );
    if (ok) result.succeeded++;
    else if (next === "skipped") result.skipped++;
    else if (next === "pending") result.retrying++;
    else {
      result.failed++;
      log.warn("attribution.postback_failed", { delivery_id: d.id, network: d.network, status, attempts: d.attempts, provider_code: providerCode });
    }
  }
  return result;
}

/** Clears IP hashes and user agents of clicks older than 7 days (probabilistic matching never looks further back). */
export async function purgeClickFingerprints(limit = 10_000): Promise<number> {
  const rows = await withSystem((db) =>
    db.query(
      `update platform.attribution_touchpoints set ip_hash = null, user_agent = null
        where id in (select id from platform.attribution_touchpoints
                      where ip_hash is not null and touchpoint_at < now() - interval '7 days' limit $1)
       returning 1`,
      [limit],
    ),
  );
  return rows.length;
}

/** The scheduled attribution work: postback delivery, Apple AdServices lookups, then fingerprint cleanup. */
export async function runAttributionJobs(opts: { deadline?: number } = {}): Promise<{
  postbacks: { succeeded: number; retrying: number; failed: number; skipped: number };
  adservices: Awaited<ReturnType<typeof runAdServicesJobs>>;
  purged_fingerprints: number;
}> {
  const postbacks = await deliverPostbacks({ deadline: opts.deadline });
  const adservices = await runAdServicesJobs({ deadline: opts.deadline });
  return { postbacks, adservices, purged_fingerprints: await purgeClickFingerprints() };
}
