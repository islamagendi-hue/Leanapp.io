import "server-only";
import type { Db } from "@/lib/db";
import { EVENT_LIBRARY } from "@/modules/implementation/catalog/events";
import type { PublishedPlan } from "@/modules/implementation/plan-store";
import {
  clickSignals, extractRevenue, INSTALL_EVENTS, isOrganicUtm, matchTypeFor, networkOfSource, organicReason, SERVER_CONTEXT_KEY, type ClickSignals, type MatchType, type PostbackPayload,
} from "./pure";
import {
  clickLookbackDays, creditEvidence, describeMatch, engineChannel, maxClickLookbackDays, maxConversionWindowDays, parseWindowOverrides, pickCredits, webMatch, webTouchOf,
  type CreditCandidate, type Credits, type WebTouch, type WindowOverrides,
} from "./pure-credit";

/**
 * The attribution step of event processing (called once per event from
 * modules/processing, inside the processing transaction, system scope).
 *
 * Per-event cost: nothing for most events. Installs, opens that carry a
 * LeanApp click id, and conversion events run a few indexed lookups.
 *
 *   app_installed       → install / reinstall, matched in order of confidence:
 *                           1. LeanApp click id (install referrer, deep link, context) of a
 *                              click our link recorded → deterministic; else the click a deferred
 *                              deep link already handed this install by click id
 *                           2. ad-network click id (gclid, fbclid, ttclid, ScCid, …): carried by a
 *                              click our link recorded → deterministic; only in the install's
 *                              context → reported
 *                           3. utm parameters the SDK captured from the link (not an organic
 *                              referrer) → reported (the install says so; nothing verifies it)
 *                           4. probabilistic (hashed IP + OS), only when enabled, never iOS: the
 *                              click a deferred deep link handed this install, else an unclaimed one
 *                           5. organic (match_key store_organic or direct when the referrer says so; null
 *                              = unattributed: nothing matched). Paid iOS installs without a click id land here: without
 *                              SKAdNetwork / AdAttributionKit or Apple Search Ads data they can't
 *                              be attributed, and iOS is never fingerprinted.
 *   A click is claimed once (touchpoint.matched_at): probabilistic matching here and in the
 *   deferred deep link API only takes unclaimed clicks.
 *   app_opened / deep_link_opened with a newer LeanApp click → re_engagement
 *   web events carrying campaign evidence (UTM parameters, a click id or an external referrer,
 *                         see pure-credit.ts webTouchOf) → web_touch, de-duplicated per visitor and
 *                         session; a LeanApp or ad-network click id our link recorded makes it deterministic
 *   conversion / revenue events → attribution_conversions with three credits among the person's
 *                         touches (installs, reinstalls, re-engagements and web touches), each within its
 *                         channel's conversion window: last touch (attribution_event_id), first touch
 *                         (first_attribution_event_id) and last non-direct touch
 *                         (last_non_direct_attribution_event_id: direct / organic / unattributed touches
 *                         never take it from a known earlier source). Every credit is appended to
 *                         attribution_conversion_credits.
 *   A touch processed after conversions it precedes (delayed or out-of-order delivery) re-credits
 *   those conversions (reason late_touch); the earlier credit stays in the history.
 * Click lookback and conversion windows can differ per channel (attribution_settings.window_overrides).
 * Every attribution event records its method, confidence and evidence (pure-credit.ts describeMatch).
 * Every install / re-engagement and conversion queues the matching postbacks; conversions go to the
 * network of their last non-direct touch. Web touches queue none themselves.
 */

export interface AttributableEvent {
  id: string;
  organization_id: string;
  app_id: string;
  environment_id: string;
  event_name: string;
  timestamp: Date;
  anonymous_id: string | null;
  user_id: string | null;
  platform: string | null;
  session_id?: string | null;
  os_version?: string | null;
  properties: Record<string, unknown>;
  context: Record<string, unknown>;
}

export interface AttributionSettings {
  click_lookback_days: number;
  probabilistic_enabled: boolean;
  probabilistic_window_hours: number;
  conversion_window_days: number;
  reengagement_enabled: boolean;
  /** Windows per channel key; the app-wide ones apply to every other channel. */
  window_overrides: WindowOverrides;
}

export const DEFAULT_SETTINGS: AttributionSettings = {
  click_lookback_days: 7,
  probabilistic_enabled: false,
  probabilistic_window_hours: 24,
  conversion_window_days: 90,
  reengagement_enabled: true,
  window_overrides: {},
};

const OPEN_EVENTS = new Set(["app_opened", "deep_link_opened"]);
/** Clicks recorded slightly after the install (clock skew between device and server) still count. */
const SKEW_MS = 5 * 60_000;
/** The same web campaign evidence again within this long (or in the same session) is the same visit. */
const WEB_TOUCH_DEDUP_MS = 30 * 60_000;
const DAY_MS = 86_400_000;


/** Whether an event is a conversion: the published plan decides, else the event library. */
export function isConversion(name: string, plan: PublishedPlan | null): boolean {
  const spec = plan?.specs.get(name);
  if (spec) return Boolean(spec.conversion_relevance || spec.revenue_relevance);
  const def = EVENT_LIBRARY[name];
  return Boolean(def && name !== "ad_impression" && (def.conversion || def.revenue));
}

async function loadSettings(db: Db, appId: string): Promise<AttributionSettings> {
  const row = await db.one<AttributionSettings>(
    `select click_lookback_days, probabilistic_enabled, probabilistic_window_hours, conversion_window_days, reengagement_enabled, window_overrides
       from platform.attribution_settings where app_id = $1`,
    [appId],
  );
  return row ? { ...row, window_overrides: parseWindowOverrides(row.window_overrides) } : DEFAULT_SETTINGS;
}

export async function attributeEvent(db: Db, e: AttributableEvent, canonical: string, plan: PublishedPlan | null): Promise<void> {
  let loaded: AttributionSettings | null = null;
  const settings = async () => (loaded ??= await loadSettings(db, e.app_id));
  if (INSTALL_EVENTS.has(canonical)) return attributeInstall(db, e, await settings());
  // A web event carrying campaign evidence is a touch first; it may be a conversion as well.
  const web = webTouchOf(e.context, e.platform);
  if (web && (e.anonymous_id || e.user_id)) await attributeWebTouch(db, e, web, await settings());
  if (OPEN_EVENTS.has(canonical)) {
    const signals = clickSignals(e.context);
    if (signals.clickId && e.anonymous_id) await attributeReengagement(db, e, signals, await settings());
    return;
  }
  if (isConversion(canonical, plan)) await attributeConversion(db, e, canonical, await settings());
}

interface TouchpointRow {
  id: string;
  source: string | null;
  medium: string | null;
  campaign: string | null;
  click_id: string | null;
  network_click_id: string | null;
  network: string | null;
  link_id: string | null;
  link_code: string | null;
  country: string | null;
  touchpoint_at: Date;
  raw: Record<string, unknown>;
}

interface Match {
  touchpoint: TouchpointRow | null;
  matchType: MatchType;
  matchKey: string | null;
  /** Handed over by the deferred deep link API. */
  deferred?: boolean;
}

/** The channel a recorded or reported click belongs to (built-in rules), for its lookback window. */
function clickChannel(t: { source: string | null; medium: string | null; network: string | null }): string {
  return engineChannel({ source: t.source, medium: t.medium, network: t.network, match_type: "reported", match_key: null });
}

/** A click is in the lookback window of its own channel (the database search used the longest window). */
function clickInWindow(tp: { source: string | null; medium: string | null; network: string | null; touchpoint_at: Date }, at: Date, s: AttributionSettings): boolean {
  return new Date(tp.touchpoint_at).getTime() >= at.getTime() - clickLookbackDays(s, clickChannel(tp)) * DAY_MS;
}

const TP_COLUMNS = `t.id, t.source, t.medium, t.campaign, t.click_id, t.network_click_id, t.network, t.link_id, l.code as link_code,
                    t.country, t.touchpoint_at, t.raw`;

function eventOs(e: AttributableEvent): "ios" | "android" | null {
  if (e.platform === "ios" || e.platform === "android") return e.platform;
  const os = (e.context.os as { name?: unknown } | undefined)?.name;
  if (typeof os === "string") {
    if (/android/i.test(os)) return "android";
    if (/ios|iphone|ipad/i.test(os)) return "ios";
  }
  return null;
}

async function findClick(db: Db, e: AttributableEvent, column: "click_id" | "network_click_id", value: string, from: Date, extra = ""): Promise<TouchpointRow | null> {
  return db.one<TouchpointRow>(
    `select ${TP_COLUMNS}
       from platform.attribution_touchpoints t
       left join platform.attribution_links l on l.id = t.link_id
      where t.environment_id = $1 and t.${column} = $2 and t.kind = 'click'
        and t.touchpoint_at >= $3 and t.touchpoint_at <= $4 ${extra}
      order by t.touchpoint_at desc limit 1`,
    [e.environment_id, value, from, new Date(e.timestamp.getTime() + SKEW_MS)],
  );
}

/** A touchpoint made from what the install's own context says (ad-network click id or utm parameters). */
async function contextTouchpoint(db: Db, e: AttributableEvent, s: ClickSignals, at: Date): Promise<TouchpointRow> {
  const network = s.networkClickId?.network ?? networkOfSource(s.utm.source);
  const source = s.utm.source ?? s.networkClickId?.network ?? null;
  const row = await db.one<{ id: string }>(
    `insert into platform.attribution_touchpoints
       (organization_id, app_id, environment_id, anonymous_id, user_id, provider, kind, source, medium, campaign, ad_group, creative,
        network_click_id, network, referrer, landing_page, touchpoint_at, raw)
     values ($1, $2, $3, $4, $5, 'sdk', 'context', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     returning id`,
    [e.organization_id, e.app_id, e.environment_id, e.anonymous_id, e.user_id, source, s.utm.medium ?? null, s.utm.campaign ?? null,
     s.utm.term ?? null, s.utm.content ?? null, s.networkClickId?.value ?? null, network, s.installReferrer, s.deepLinkUrl, at,
     JSON.stringify(s.networkClickId ? { network_click_param: s.networkClickId.param } : {})],
  );
  return {
    id: row!.id, source, medium: s.utm.medium ?? null, campaign: s.utm.campaign ?? null, click_id: null,
    network_click_id: s.networkClickId?.value ?? null, network, link_id: null, link_code: null, country: null, touchpoint_at: at,
    raw: s.networkClickId ? { network_click_param: s.networkClickId.param } : {},
  };
}

async function findMatch(db: Db, e: AttributableEvent, settings: AttributionSettings): Promise<Match> {
  const s = clickSignals(e.context);
  // The longest lookback any channel uses; each found click is then held to its own channel's window.
  const from = new Date(e.timestamp.getTime() - maxClickLookbackDays(settings) * DAY_MS);
  const fits = (tp: TouchpointRow | null) => (tp && clickInWindow(tp, e.timestamp, settings) ? tp : null);

  // 1. LeanApp click id: exact, against a click our own link recorded.
  if (s.clickId) {
    const tp = fits(await findClick(db, e, "click_id", s.clickId.value, from));
    if (tp) return { touchpoint: tp, matchType: matchTypeFor("recorded_click"), matchKey: s.clickId.key };
  }
  // A deferred deep link lookup may already have handed this install a click: the install
  // keeps that click, so one click never goes to two installs. A click-id claim counts here;
  // a probabilistic one keeps its place in step 4.
  const claimed = e.anonymous_id ? await deferredClaim(db, e, from) : null;
  const deferred = claimed?.touchpoint && clickInWindow(claimed.touchpoint, e.timestamp, settings) ? claimed : null;
  if (deferred?.matchType === "deterministic") return deferred;
  // The Play referrer API reports when the store click happened: older than the lookback window
  // of the channel the parameters name means organic.
  const campaign = (e.context.campaign ?? {}) as Record<string, unknown>;
  const clickSeconds = Number(campaign.referrer_click_timestamp_seconds);
  const clickAt = Number.isFinite(clickSeconds) && clickSeconds > 0 ? new Date(clickSeconds * 1000) : null;
  const contextChannel = clickChannel({ source: s.utm.source ?? null, medium: s.utm.medium ?? null, network: s.networkClickId?.network ?? networkOfSource(s.utm.source) });
  const inWindow = !clickAt || clickAt.getTime() >= e.timestamp.getTime() - clickLookbackDays(settings, contextChannel) * DAY_MS;

  // 2. Ad-network click id: carried by a click our link recorded (deterministic), else only the
  // install's context reports it (reported: nothing of ours verifies it).
  if (s.networkClickId) {
    const tp = fits(await findClick(db, e, "network_click_id", s.networkClickId.value, from));
    if (tp) return { touchpoint: tp, matchType: matchTypeFor("recorded_click"), matchKey: s.networkClickId.param };
    if (inWindow) return { touchpoint: await contextTouchpoint(db, e, s, clickAt ?? e.timestamp), matchType: matchTypeFor("install_context"), matchKey: s.networkClickId.param };
  }
  // 3. Campaign parameters captured from the link that opened or installed the app: reported.
  // An organic referrer (Play's "utm_medium=organic") is not a campaign.
  if (s.utm.source && inWindow && !isOrganicUtm(s.utm)) {
    return { touchpoint: await contextTouchpoint(db, e, s, clickAt ?? e.timestamp), matchType: matchTypeFor("install_context"), matchKey: s.installReferrer ? "install_referrer" : "utm_parameters" };
  }
  // 4a. The click a probabilistic deferred deep link lookup already handed this install.
  if (deferred) return deferred;
  // 4b. Probabilistic: opt-in, Android only (no fingerprinting on iOS), short window, unclaimed clicks only.
  // The row lock (held until the processing transaction commits, by when matched_at is set) and
  // matched_at keep a concurrent deferred deep link lookup from handing out the same click.
  const ipHash = ((e.context[SERVER_CONTEXT_KEY] ?? {}) as { ip_hash?: string }).ip_hash;
  if (settings.probabilistic_enabled && ipHash && eventOs(e) === "android") {
    const window = new Date(e.timestamp.getTime() - settings.probabilistic_window_hours * 3_600_000);
    const major = /^(\d+)/.exec(e.os_version ?? "")?.[1] ?? null;
    const tp = await db.one<TouchpointRow>(
      `select ${TP_COLUMNS}
         from platform.attribution_touchpoints t
         left join platform.attribution_links l on l.id = t.link_id
        where t.environment_id = $1 and t.ip_hash = $2 and t.kind = 'click' and t.os_name = 'android'
          and ($3::text is null or t.os_major is null or t.os_major = $3)
          and t.matched_at is null
          and t.touchpoint_at >= greatest($4::timestamptz, $5::timestamptz) and t.touchpoint_at <= $6
        order by t.touchpoint_at desc limit 1
        for update of t skip locked`,
      [e.environment_id, ipHash, major, window, from, new Date(e.timestamp.getTime() + SKEW_MS)],
    );
    if (fits(tp)) return { touchpoint: tp, matchType: matchTypeFor("ip_os"), matchKey: "ip_ua" };
  }
  // 5. Organic or unattributed: an organic store referrer or "direct" parameters say why
  // (match_key store_organic / direct); otherwise nothing matched (match_key null = unattributed).
  return { touchpoint: null, matchType: matchTypeFor("none"), matchKey: s.utm.source && inWindow ? organicReason(s.utm) : null };
}

/** The click the deferred deep link API handed this install (within the click lookback), if any. */
async function deferredClaim(db: Db, e: AttributableEvent, from: Date): Promise<Match | null> {
  const row = await db.one<TouchpointRow & { deferred_match_type: string; deferred_match_key: string | null }>(
    `select ${TP_COLUMNS}, m.match_type as deferred_match_type, m.match_key as deferred_match_key
       from platform.deep_link_deferred_matches m
       join platform.attribution_touchpoints t on t.id = m.touchpoint_id
       left join platform.attribution_links l on l.id = t.link_id
      where m.environment_id = $1 and m.anonymous_id = $2 and m.match_type in ('deterministic', 'probabilistic')
        and t.touchpoint_at >= $3 and t.touchpoint_at <= $4`,
    [e.environment_id, e.anonymous_id, from, new Date(e.timestamp.getTime() + SKEW_MS)],
  );
  if (!row) return null;
  const { deferred_match_type, deferred_match_key, ...tp } = row;
  return { touchpoint: tp, matchType: matchTypeFor(deferred_match_type === "deterministic" ? "recorded_click" : "ip_os"), matchKey: deferred_match_key, deferred: true };
}

/** What a decision rests on, beyond the match itself (stored in attribution_events.evidence). */
interface DecisionExtra {
  referrerHost?: string | null;
  sessionId?: string | null;
  touchSignature?: string | null;
  evidence?: Record<string, unknown>;
  /** Queue postbacks for this attribution (installs and re-engagements). */
  postbacks?: boolean;
}

/** Names of the signals an install or open carried (never their values). */
function signalKeys(s: ClickSignals): string[] {
  const keys: string[] = [];
  if (s.clickId) keys.push(s.clickId.key === "click_id" ? "click_id" : `click_id:${s.clickId.key}`);
  if (s.networkClickId) keys.push(s.networkClickId.param);
  for (const [k, v] of Object.entries(s.utm)) if (v) keys.push(`utm_${k}`);
  if (s.installReferrer) keys.push("install_referrer");
  if (s.deepLinkUrl) keys.push("deep_link_url");
  return keys;
}

async function recordAttribution(
  db: Db,
  e: AttributableEvent,
  kind: "install" | "reinstall" | "re_engagement" | "web_touch",
  m: Match,
  settings: AttributionSettings,
  extra: DecisionExtra = { postbacks: true },
): Promise<string | null> {
  const tp = m.touchpoint;
  const deviceId = ((e.context.device ?? {}) as { id?: unknown }).id;
  const network = tp ? tp.network ?? networkOfSource(tp.source) : null;
  const decision = describeMatch(m.matchType, m.matchKey, { ios: e.platform === "ios", deferred: m.deferred });
  const channel = engineChannel({
    source: tp?.source ?? null, medium: tp?.medium ?? null, network, match_type: m.matchType, match_key: m.matchKey, referrer_host: extra.referrerHost ?? null, campaign: tp?.campaign ?? null,
  });
  const evidence = {
    channel,
    limitations: decision.limitations,
    ...(tp ? { touch_at: new Date(tp.touchpoint_at).toISOString(), touch_kind: kind === "web_touch" ? "web" : tp.click_id || tp.link_id ? "click" : "context" } : {}),
    ...(kind === "web_touch" ? {} : { click_lookback_days: clickLookbackDays(settings, channel), signals: signalKeys(clickSignals(e.context)) }),
    ...extra.evidence,
  };
  const row = await db.one<{ id: string }>(
    `insert into platform.attribution_events
       (organization_id, app_id, environment_id, kind, anonymous_id, user_id, touchpoint_id, provider, model, occurred_at,
        match_type, match_key, event_row_id, device_id, platform, link_id, source, medium, campaign, network,
        method, confidence, evidence, referrer_host, session_id, touch_signature)
     values ($1, $2, $3, $4, $5, $6, $7, 'native', 'last_touch', $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
     on conflict do nothing
     returning id`,
    [e.organization_id, e.app_id, e.environment_id, kind, e.anonymous_id, e.user_id, tp?.id ?? null, e.timestamp, m.matchType, m.matchKey,
     e.id, typeof deviceId === "string" ? deviceId.slice(0, 200) : null, e.platform, tp?.link_id ?? null, tp?.source ?? null, tp?.medium ?? null,
     tp?.campaign ?? null, network, decision.method, decision.confidence, JSON.stringify(evidence), extra.referrerHost ?? null,
     extra.sessionId ?? null, extra.touchSignature ?? null],
  );
  if (!row) return null; // already attributed (reprocessing)
  if (tp) {
    await db.query(
      "update platform.attribution_touchpoints set matched_at = coalesce(matched_at, $2), anonymous_id = coalesce(anonymous_id, $3) where id = $1",
      [tp.id, e.timestamp, e.anonymous_id],
    );
  }
  if (extra.postbacks !== false) {
    await enqueuePostbacks(db, {
      environmentId: e.environment_id,
      eventName: kind,
      attributionEventId: row.id,
      conversionId: null,
      idempotencyKey: `${kind}:${row.id}`,
      matchType: m.matchType,
      source: tp?.source ?? null,
      network,
      payload: payloadFor(e, kind, `${kind}:${row.id}`, tp, m.matchType, e.timestamp, null),
    });
  }
  // Conversions this touch precedes that were processed before it (delayed or out-of-order delivery).
  await recreditLateConversions(db, e, settings);
  return row.id;
}

async function attributeInstall(db: Db, e: AttributableEvent, settings: AttributionSettings) {
  if (!e.anonymous_id) return;
  const existing = await db.one(
    "select 1 from platform.attribution_events where environment_id = $1 and anonymous_id = $2 and kind in ('install', 'reinstall')",
    [e.environment_id, e.anonymous_id],
  );
  if (existing) return;
  // A new install of a device or user we have seen install before is a reinstall.
  const deviceId = ((e.context.device ?? {}) as { id?: unknown }).id;
  const prior = await db.one(
    `select 1 from platform.attribution_events
      where environment_id = $1 and kind in ('install', 'reinstall') and occurred_at <= $4
        and ((device_id is not null and device_id = $2) or (user_id is not null and user_id = $3))
      limit 1`,
    [e.environment_id, typeof deviceId === "string" ? deviceId : null, e.user_id, e.timestamp],
  );
  const match = await findMatch(db, e, settings);
  await recordAttribution(db, e, prior ? "reinstall" : "install", match, settings);
}

async function attributeReengagement(db: Db, e: AttributableEvent, s: ClickSignals, settings: AttributionSettings) {
  if (!settings.reengagement_enabled || !s.clickId) return;
  const from = new Date(e.timestamp.getTime() - maxClickLookbackDays(settings) * DAY_MS);
  const found = await findClick(db, e, "click_id", s.clickId.value, from);
  const tp = found && clickInWindow(found, e.timestamp, settings) ? found : null;
  if (!tp) return;
  const install = await db.one<{ occurred_at: Date }>(
    "select occurred_at from platform.attribution_events where environment_id = $1 and anonymous_id = $2 and kind in ('install', 'reinstall')",
    [e.environment_id, e.anonymous_id],
  );
  // Only a click after the install re-engages; the click that drove the install is the install's.
  if (!install || tp.touchpoint_at <= install.occurred_at) return;
  const already = await db.one(
    "select 1 from platform.attribution_events where environment_id = $1 and anonymous_id = $2 and touchpoint_id = $3",
    [e.environment_id, e.anonymous_id, tp.id],
  );
  if (already) return;
  await recordAttribution(db, e, "re_engagement", { touchpoint: tp, matchType: matchTypeFor("recorded_click"), matchKey: s.clickId.key }, settings);
}

/**
 * A web visit that carried campaign evidence. The same evidence from the same
 * visitor in the same session or within 30 minutes is one visit (the SDK
 * repeats the attribution context on the first event of every session and on
 * its landing event); a re-sent first touch is recorded once. The raw
 * touchpoint keeps the landing page (without its query string), the referring
 * host and the names of the keys that were present.
 */
async function attributeWebTouch(db: Db, e: AttributableEvent, w: WebTouch, settings: AttributionSettings) {
  const ts = e.timestamp.getTime();
  const dup = await db.one(
    `select 1 from platform.attribution_events
      where environment_id = $1 and kind = 'web_touch' and touch_signature = $2
        and (anonymous_id = $3 or ($4::text is not null and user_id = $4))
        and ($5::boolean or ($6::text is not null and session_id = $6) or occurred_at between $7 and $8)
      limit 1`,
    [e.environment_id, w.signature, e.anonymous_id, e.user_id, w.touch === "first", w.touch === "first" ? null : sessionOf(e),
     new Date(ts - WEB_TOUCH_DEDUP_MS), new Date(ts + WEB_TOUCH_DEDUP_MS)],
  );
  if (dup) return;

  // A click id backed by a click LeanApp's own link recorded is deterministic.
  const from = new Date(ts - maxClickLookbackDays(settings) * DAY_MS);
  let click: TouchpointRow | null = null;
  let m: { matchType: MatchType; matchKey: string } = webMatch(w);
  if (w.signals.clickId) {
    const tp = await findClick(db, e, "click_id", w.signals.clickId.value, from);
    if (tp && clickInWindow(tp, e.timestamp, settings)) {
      click = tp;
      m = { matchType: "deterministic", matchKey: "click_id" };
    }
  }
  if (!click && w.signals.networkClickId) {
    const tp = await findClick(db, e, "network_click_id", w.signals.networkClickId.value, from);
    if (tp && clickInWindow(tp, e.timestamp, settings)) {
      click = tp;
      m = { matchType: "deterministic", matchKey: w.signals.networkClickId.param };
    }
  }
  const u = w.signals.utm;
  const source = click?.source ?? u.source ?? w.signals.networkClickId?.network ?? null;
  const medium = click?.medium ?? u.medium ?? null;
  const campaign = click?.campaign ?? u.campaign ?? null;
  const network = click?.network ?? w.signals.networkClickId?.network ?? networkOfSource(source);
  const raw: Record<string, unknown> = { keys: w.keys };
  if (w.touch) raw.touch = w.touch;
  if (click) raw.click_touchpoint_id = click.id;
  if (w.signals.networkClickId) raw.network_click_param = w.signals.networkClickId.param;
  const row = await db.one<{ id: string }>(
    `insert into platform.attribution_touchpoints
       (organization_id, app_id, environment_id, anonymous_id, user_id, provider, kind, source, medium, campaign, campaign_id, ad_group, ad_group_id,
        creative, creative_id, click_id, network_click_id, network, link_id, referrer, landing_page, touchpoint_at, raw)
     values ($1, $2, $3, $4, $5, 'sdk', 'web', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
     returning id`,
    [e.organization_id, e.app_id, e.environment_id, e.anonymous_id, e.user_id, source, medium, campaign, w.campaignId, u.term ?? null,
     w.adsetId, u.content ?? null, w.adId, click?.click_id ?? null, w.signals.networkClickId?.value ?? click?.network_click_id ?? null, network,
     click?.link_id ?? null, w.referrerHost, w.landingPage, e.timestamp, JSON.stringify(raw)],
  );
  if (click) {
    // The recorded click led to this visit: probabilistic install matching never hands it out again.
    await db.query("update platform.attribution_touchpoints set matched_at = coalesce(matched_at, $2) where id = $1", [click.id, e.timestamp]);
  }
  const tp: TouchpointRow = {
    id: row!.id, source, medium, campaign, click_id: click?.click_id ?? null, network_click_id: w.signals.networkClickId?.value ?? click?.network_click_id ?? null,
    network, link_id: click?.link_id ?? null, link_code: click?.link_code ?? null, country: click?.country ?? null, touchpoint_at: e.timestamp, raw,
  };
  await recordAttribution(db, e, "web_touch", { touchpoint: tp, matchType: m.matchType, matchKey: m.matchKey }, settings, {
    postbacks: false,
    referrerHost: w.referrerHost,
    sessionId: sessionOf(e),
    touchSignature: w.signature,
    evidence: {
      signals: w.keys,
      landing_host: w.landingHost,
      ...(w.referrerHost ? { referrer_host: w.referrerHost } : {}),
      ...(w.touch ? { sdk_touch: w.touch } : {}),
      ...(click ? { recorded_click: true } : {}),
    },
  });
}

function sessionOf(e: AttributableEvent): string | null {
  return typeof e.session_id === "string" && e.session_id ? e.session_id.slice(0, 200) : null;
}

type TouchCandidate = CreditCandidate & { referrer_host: string | null; campaign: string | null };

/** The person's touches (by install, user id or a linked install) between two instants, newest first. */
async function personTouches(db: Db, environmentId: string, anonymousId: string | null, userId: string | null, from: Date, to: Date): Promise<TouchCandidate[]> {
  return db.query<TouchCandidate>(
    `select ae.id, ae.kind, ae.source, ae.medium, ae.network, ae.match_type, ae.match_key, ae.referrer_host, ae.campaign, ae.occurred_at
       from platform.attribution_events ae
      where ae.environment_id = $1 and ae.occurred_at <= $2 and ae.occurred_at >= $3
        and ae.kind in ('install', 'reinstall', 're_engagement', 'web_touch')
        and (ae.anonymous_id = $4
             or ($5::text is not null and ae.user_id = $5)
             or ($5::text is not null and ae.anonymous_id in (select anonymous_id from platform.identity_links where environment_id = $1 and user_id = $5)))
      order by ae.occurred_at desc, ae.id desc limit 500`,
    [environmentId, to, from, anonymousId, userId],
  );
}

async function creditsFor(db: Db, environmentId: string, anonymousId: string | null, userId: string | null, at: Date, settings: AttributionSettings): Promise<Credits<TouchCandidate>> {
  const from = new Date(at.getTime() - maxConversionWindowDays(settings) * DAY_MS);
  const touches = await personTouches(db, environmentId, anonymousId, userId, from, new Date(at.getTime() + SKEW_MS));
  return pickCredits(touches, at, settings, SKEW_MS);
}

type CreditTouch = { id: string; match_type: Match["matchType"]; source: string | null; network: string | null; occurred_at: Date; install_at: Date | null }
  & Partial<TouchpointRow> & { tp_id: string | null };

/** The stored touch a conversion is credited to, with its touchpoint, for the postback payload. */
async function loadCreditTouch(db: Db, id: string): Promise<CreditTouch | null> {
  return db.one<CreditTouch>(
    `select ae.id, ae.match_type, ae.source, ae.network, ae.occurred_at, t.id as tp_id, t.medium, t.campaign, t.click_id, t.network_click_id,
            t.link_id, l.code as link_code, t.country, t.raw,
            (select min(i.occurred_at) from platform.attribution_events i
              where i.environment_id = ae.environment_id and i.anonymous_id = ae.anonymous_id and i.kind in ('install', 'reinstall')) as install_at
       from platform.attribution_events ae
       left join platform.attribution_touchpoints t on t.id = ae.touchpoint_id
       left join platform.attribution_links l on l.id = t.link_id
      where ae.id = $1`,
    [id],
  );
}

async function queueConversionPostbacks(
  db: Db, e: AttributableEvent, name: string, conversionId: string, creditId: string, money: { revenue: number | null; currency: string | null },
) {
  const ae = await loadCreditTouch(db, creditId);
  if (!ae) return;
  const tp: TouchpointRow | null = ae.tp_id
    ? {
        id: ae.tp_id, source: ae.source, medium: ae.medium ?? null, campaign: ae.campaign ?? null, click_id: ae.click_id ?? null,
        network_click_id: ae.network_click_id ?? null, network: ae.network, link_id: ae.link_id ?? null, link_code: ae.link_code ?? null,
        country: ae.country ?? null, touchpoint_at: ae.occurred_at, raw: ae.raw ?? {},
      }
    : null;
  await enqueuePostbacks(db, {
    environmentId: e.environment_id,
    eventName: name,
    attributionEventId: ae.id,
    conversionId,
    idempotencyKey: `conversion:${conversionId}`,
    matchType: ae.match_type,
    source: ae.source,
    network: ae.network,
    payload: payloadFor(e, name, `conversion:${conversionId}`, tp, ae.match_type, ae.install_at ?? ae.occurred_at, money),
  });
}

async function recordCredit(db: Db, e: Pick<AttributableEvent, "organization_id" | "app_id" | "environment_id">, conversionId: string, reason: "initial" | "late_touch", c: Credits, evidence: Record<string, unknown>) {
  await db.query(
    `insert into platform.attribution_conversion_credits
       (organization_id, app_id, environment_id, conversion_id, reason, last_touch_event_id, first_touch_event_id, last_non_direct_event_id, evidence)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [e.organization_id, e.app_id, e.environment_id, conversionId, reason, c.lastTouch?.id ?? null, c.firstTouch?.id ?? null, c.lastNonDirect?.id ?? null,
     JSON.stringify(evidence)],
  );
}

async function attributeConversion(db: Db, e: AttributableEvent, name: string, settings: AttributionSettings) {
  if (!e.anonymous_id && !e.user_id) return;
  const credits = await creditsFor(db, e.environment_id, e.anonymous_id, e.user_id, e.timestamp, settings);
  const evidence = creditEvidence(credits, settings);
  const { revenue, currency } = extractRevenue(name, e.properties);
  const conv = await db.one<{ id: string }>(
    `insert into platform.attribution_conversions (organization_id, app_id, environment_id, attribution_event_id, first_attribution_event_id, first_touch_recorded,
                                                   last_non_direct_attribution_event_id, last_non_direct_recorded, credit_evidence,
                                                   event_row_id, event_name, revenue, currency, occurred_at)
     values ($1, $2, $3, $4, $5, true, $6, true, $7, $8, $9, $10, $11, $12)
     on conflict do nothing returning id`,
    [e.organization_id, e.app_id, e.environment_id, credits.lastTouch?.id ?? null, credits.firstTouch?.id ?? null, credits.lastNonDirect?.id ?? null,
     JSON.stringify(evidence), e.id, name, revenue, currency, e.timestamp],
  );
  if (!conv) return;
  await recordCredit(db, e, conv.id, "initial", credits, evidence);
  // Networks hear about the conversions of the touch they drove: a later direct or organic touch doesn't take it away.
  if (credits.lastNonDirect) await queueConversionPostbacks(db, e, name, conv.id, credits.lastNonDirect.id, { revenue, currency });
}

/**
 * Re-credits the conversions of this event's person that happened after it but
 * were processed before it (the touch arrived late or out of order). Each
 * changed credit is appended to the history with reason late_touch; a
 * conversion that had no credited touch before queues its postbacks now. Only
 * conversions recorded since migration 0039 are re-credited.
 */
async function recreditLateConversions(db: Db, e: AttributableEvent, settings: AttributionSettings) {
  if (!e.anonymous_id && !e.user_id) return;
  const ids = await db.one<{ anons: string[]; users: string[] }>(
    `with u as (select $3::text as user_id where $3::text is not null
                union select user_id from platform.identity_links where environment_id = $1 and anonymous_id = $2),
          a as (select $2::text as anonymous_id where $2::text is not null
                union select anonymous_id from platform.identity_links where environment_id = $1 and user_id in (select user_id from u))
     select array(select anonymous_id from a) as anons, array(select user_id from u where user_id is not null) as users`,
    [e.environment_id, e.anonymous_id, e.user_id],
  );
  const later = await db.query<{
    id: string; event_name: string; occurred_at: Date; revenue: string | null; currency: string | null; anonymous_id: string | null; user_id: string | null;
    attribution_event_id: string | null; first_attribution_event_id: string | null; last_non_direct_attribution_event_id: string | null; last_non_direct_recorded: boolean;
  }>(
    `select c.id, c.event_name, c.occurred_at, c.revenue::text, c.currency, ev.anonymous_id, ev.user_id,
            c.attribution_event_id, c.first_attribution_event_id, c.last_non_direct_attribution_event_id, c.last_non_direct_recorded
       from platform.events ev
       join platform.attribution_conversions c on c.environment_id = ev.environment_id and c.event_row_id = ev.id
      where ev.environment_id = $1 and ev."timestamp" >= $2 and ev."timestamp" <= $3 and ev.id <> $6
        and (ev.anonymous_id = any($4::text[]) or ev.user_id = any($5::text[]))
        and c.last_non_direct_recorded
      order by ev."timestamp" limit 100`,
    [e.environment_id, new Date(e.timestamp.getTime() - SKEW_MS), new Date(e.timestamp.getTime() + maxConversionWindowDays(settings) * DAY_MS),
     ids?.anons ?? [], ids?.users ?? [], e.id],
  );
  for (const c of later) {
    const credits = await creditsFor(db, e.environment_id, c.anonymous_id, c.user_id, new Date(c.occurred_at), settings);
    const same = (credits.lastTouch?.id ?? null) === c.attribution_event_id && (credits.firstTouch?.id ?? null) === c.first_attribution_event_id
      && (credits.lastNonDirect?.id ?? null) === c.last_non_direct_attribution_event_id;
    if (same) continue;
    const evidence = { ...creditEvidence(credits, settings), recredited_by_event_row: e.id };
    await db.query(
      `update platform.attribution_conversions
          set attribution_event_id = $2, first_attribution_event_id = $3, last_non_direct_attribution_event_id = $4, credit_evidence = $5
        where id = $1`,
      [c.id, credits.lastTouch?.id ?? null, credits.firstTouch?.id ?? null, credits.lastNonDirect?.id ?? null, JSON.stringify(evidence)],
    );
    await recordCredit(db, e, c.id, "late_touch", credits, evidence);
    if (!c.last_non_direct_attribution_event_id && credits.lastNonDirect) {
      const money = { revenue: c.revenue === null ? null : Number(c.revenue), currency: c.currency };
      await queueConversionPostbacks(db, { ...e, timestamp: new Date(c.occurred_at) }, c.event_name, c.id, credits.lastNonDirect.id, money);
    }
  }
}

function payloadFor(
  e: AttributableEvent,
  event: string,
  eventId: string,
  tp: TouchpointRow | null,
  matchType: Match["matchType"],
  installAt: Date,
  money: { revenue: number | null; currency: string | null } | null,
): PostbackPayload {
  return {
    event,
    event_id: eventId,
    click_id: tp?.click_id ?? null,
    network_click_id: tp?.network_click_id ?? null,
    network_click_param: typeof tp?.raw?.network_click_param === "string" ? tp.raw.network_click_param : null,
    revenue: money?.revenue ?? null,
    currency: money?.currency ?? null,
    timestamp: Math.floor(e.timestamp.getTime() / 1000),
    event_time: e.timestamp.toISOString(),
    install_timestamp: Math.floor(new Date(installAt).getTime() / 1000),
    platform: e.platform,
    source: tp?.source ?? null,
    medium: tp?.medium ?? null,
    campaign: tp?.campaign ?? null,
    link_code: tp?.link_code ?? null,
    match_type: matchType,
    country: tp?.country ?? null,
  };
}

/**
 * Queues one delivery per active postback of the environment that wants this
 * event: ad-network postbacks get their own network's attributed events (or
 * the sources listed), custom postbacks every attributed event (or the listed
 * sources), and organic ones only when they opted in. Idempotent per postback.
 */
async function enqueuePostbacks(
  db: Db,
  q: { environmentId: string; eventName: string; attributionEventId: string; conversionId: string | null; idempotencyKey: string;
       matchType: Match["matchType"]; source: string | null; network: string | null; payload: PostbackPayload },
) {
  await db.query(
    `insert into platform.attribution_postback_deliveries
       (organization_id, environment_id, postback_id, attribution_event_id, conversion_id, event_name, idempotency_key, payload)
     select p.organization_id, p.environment_id, p.id, $3, $4, $2, $5, $6
       from platform.attribution_postbacks p
      where p.environment_id = $1 and p.status = 'active' and $2 = any(p.events)
        and case when $7 = 'organic' then p.network = 'custom' and p.include_organic
                 when cardinality(p.sources) > 0 then lower(coalesce($8, '')) = any(p.sources)
                 else p.network = 'custom' or p.network = $9 end
     on conflict (postback_id, idempotency_key) do nothing`,
    [q.environmentId, q.eventName, q.attributionEventId, q.conversionId, q.idempotencyKey, JSON.stringify(q.payload), q.matchType, q.source, q.network],
  );
}
