import "server-only";
import type { Db } from "@/lib/db";
import { EVENT_LIBRARY } from "@/modules/implementation/catalog/events";
import type { PublishedPlan } from "@/modules/implementation/plan-store";
import { clickSignals, extractRevenue, INSTALL_EVENTS, isOrganicUtm, networkOfSource, SERVER_CONTEXT_KEY, type ClickSignals, type PostbackPayload } from "./pure";

/**
 * The attribution step of event processing (called once per event from
 * modules/processing, inside the processing transaction, system scope).
 *
 * Per-event cost: nothing for most events. Installs, opens that carry a
 * LeanApp click id, and conversion events run a few indexed lookups.
 *
 *   app_installed       → install / reinstall, matched in order of confidence:
 *                           1. LeanApp click id (install referrer, deep link, context)
 *                           2. ad-network click id (gclid, fbclid, ttclid, ScCid, …)
 *                           3. utm parameters the SDK captured from the link (not an organic referrer)
 *                           4. probabilistic (hashed IP + OS), only when enabled, never iOS
 *                           5. organic
 *   app_opened / deep_link_opened with a newer LeanApp click → re_engagement
 *   conversion / revenue events → attribution_conversions, last touch
 * Every attribution event and conversion queues the matching postbacks.
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
}

export const DEFAULT_SETTINGS: AttributionSettings = {
  click_lookback_days: 7,
  probabilistic_enabled: false,
  probabilistic_window_hours: 24,
  conversion_window_days: 90,
  reengagement_enabled: true,
};

const OPEN_EVENTS = new Set(["app_opened", "deep_link_opened"]);
/** Clicks recorded slightly after the install (clock skew between device and server) still count. */
const SKEW_MS = 5 * 60_000;


/** Whether an event is a conversion: the published plan decides, else the event library. */
export function isConversion(name: string, plan: PublishedPlan | null): boolean {
  const spec = plan?.specs.get(name);
  if (spec) return Boolean(spec.conversion_relevance || spec.revenue_relevance);
  const def = EVENT_LIBRARY[name];
  return Boolean(def && name !== "ad_impression" && (def.conversion || def.revenue));
}

async function loadSettings(db: Db, appId: string): Promise<AttributionSettings> {
  const row = await db.one<AttributionSettings>(
    `select click_lookback_days, probabilistic_enabled, probabilistic_window_hours, conversion_window_days, reengagement_enabled
       from platform.attribution_settings where app_id = $1`,
    [appId],
  );
  return row ?? DEFAULT_SETTINGS;
}

export async function attributeEvent(db: Db, e: AttributableEvent, canonical: string, plan: PublishedPlan | null): Promise<void> {
  if (INSTALL_EVENTS.has(canonical)) return attributeInstall(db, e, await loadSettings(db, e.app_id));
  if (OPEN_EVENTS.has(canonical)) {
    const signals = clickSignals(e.context);
    if (signals.clickId && e.anonymous_id) await attributeReengagement(db, e, signals, await loadSettings(db, e.app_id));
    return;
  }
  if (isConversion(canonical, plan)) await attributeConversion(db, e, canonical, await loadSettings(db, e.app_id));
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
  matchType: "deterministic" | "probabilistic" | "organic";
  matchKey: string | null;
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
  const from = new Date(e.timestamp.getTime() - settings.click_lookback_days * 86_400_000);

  // 1. LeanApp click id: exact.
  if (s.clickId) {
    const tp = await findClick(db, e, "click_id", s.clickId.value, from);
    if (tp) return { touchpoint: tp, matchType: "deterministic", matchKey: s.clickId.key };
  }
  // The Play referrer API reports when the store click happened: older than the lookback window means organic.
  const campaign = (e.context.campaign ?? {}) as Record<string, unknown>;
  const clickSeconds = Number(campaign.referrer_click_timestamp_seconds);
  const clickAt = Number.isFinite(clickSeconds) && clickSeconds > 0 ? new Date(clickSeconds * 1000) : null;
  const inWindow = !clickAt || clickAt >= from;

  // 2. Ad-network click id: a recorded click that carried it, else the context itself.
  if (s.networkClickId) {
    const tp = await findClick(db, e, "network_click_id", s.networkClickId.value, from);
    if (tp) return { touchpoint: tp, matchType: "deterministic", matchKey: s.networkClickId.param };
    if (inWindow) return { touchpoint: await contextTouchpoint(db, e, s, clickAt ?? e.timestamp), matchType: "deterministic", matchKey: s.networkClickId.param };
  }
  // 3. Campaign parameters captured from the link that opened or installed the app.
  // An organic referrer (Play's "utm_medium=organic") is not a campaign.
  if (s.utm.source && inWindow && !isOrganicUtm(s.utm)) {
    return { touchpoint: await contextTouchpoint(db, e, s, clickAt ?? e.timestamp), matchType: "deterministic", matchKey: s.installReferrer ? "install_referrer" : "utm_parameters" };
  }
  // 4. Probabilistic: opt-in, Android only (no fingerprinting on iOS), short window, unclaimed clicks only.
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
        order by t.touchpoint_at desc limit 1`,
      [e.environment_id, ipHash, major, window, from, new Date(e.timestamp.getTime() + SKEW_MS)],
    );
    if (tp) return { touchpoint: tp, matchType: "probabilistic", matchKey: "ip_ua" };
  }
  return { touchpoint: null, matchType: "organic", matchKey: null };
}

async function recordAttribution(
  db: Db,
  e: AttributableEvent,
  kind: "install" | "reinstall" | "re_engagement",
  m: Match,
): Promise<string | null> {
  const tp = m.touchpoint;
  const deviceId = ((e.context.device ?? {}) as { id?: unknown }).id;
  const network = tp ? tp.network ?? networkOfSource(tp.source) : null;
  const row = await db.one<{ id: string }>(
    `insert into platform.attribution_events
       (organization_id, app_id, environment_id, kind, anonymous_id, user_id, touchpoint_id, provider, model, occurred_at,
        match_type, match_key, event_row_id, device_id, platform, link_id, source, medium, campaign, network)
     values ($1, $2, $3, $4, $5, $6, $7, 'native', 'last_touch', $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
     on conflict do nothing
     returning id`,
    [e.organization_id, e.app_id, e.environment_id, kind, e.anonymous_id, e.user_id, tp?.id ?? null, e.timestamp, m.matchType, m.matchKey,
     e.id, typeof deviceId === "string" ? deviceId.slice(0, 200) : null, e.platform, tp?.link_id ?? null, tp?.source ?? null, tp?.medium ?? null,
     tp?.campaign ?? null, network],
  );
  if (!row) return null; // already attributed (reprocessing)
  if (tp) {
    await db.query(
      "update platform.attribution_touchpoints set matched_at = coalesce(matched_at, $2), anonymous_id = coalesce(anonymous_id, $3) where id = $1",
      [tp.id, e.timestamp, e.anonymous_id],
    );
  }
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
  await recordAttribution(db, e, prior ? "reinstall" : "install", match);
}

async function attributeReengagement(db: Db, e: AttributableEvent, s: ClickSignals, settings: AttributionSettings) {
  if (!settings.reengagement_enabled || !s.clickId) return;
  const from = new Date(e.timestamp.getTime() - settings.click_lookback_days * 86_400_000);
  const tp = await findClick(db, e, "click_id", s.clickId.value, from);
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
  await recordAttribution(db, e, "re_engagement", { touchpoint: tp, matchType: "deterministic", matchKey: s.clickId.key });
}

async function attributeConversion(db: Db, e: AttributableEvent, name: string, settings: AttributionSettings) {
  if (!e.anonymous_id && !e.user_id) return;
  const from = new Date(e.timestamp.getTime() - settings.conversion_window_days * 86_400_000);
  // Last touch: the latest install / reinstall / re-engagement of this install or user before the conversion.
  const ae = await db.one<{ id: string; match_type: Match["matchType"]; source: string | null; network: string | null; occurred_at: Date; install_at: Date | null } & Partial<TouchpointRow> & { tp_id: string | null }>(
    `select ae.id, ae.match_type, ae.source, ae.network, ae.occurred_at, t.id as tp_id, t.medium, t.campaign, t.click_id, t.network_click_id,
            t.link_id, l.code as link_code, t.country, t.raw,
            (select min(i.occurred_at) from platform.attribution_events i
              where i.environment_id = ae.environment_id and i.anonymous_id = ae.anonymous_id and i.kind in ('install', 'reinstall')) as install_at
       from platform.attribution_events ae
       left join platform.attribution_touchpoints t on t.id = ae.touchpoint_id
       left join platform.attribution_links l on l.id = t.link_id
      where ae.environment_id = $1 and ae.occurred_at <= $2 and ae.occurred_at >= $3
        and (ae.anonymous_id = $4
             or ($5::text is not null and ae.user_id = $5)
             or ($5::text is not null and ae.anonymous_id in (select anonymous_id from platform.identity_links where environment_id = $1 and user_id = $5)))
      order by ae.occurred_at desc limit 1`,
    [e.environment_id, new Date(e.timestamp.getTime() + SKEW_MS), from, e.anonymous_id, e.user_id],
  );
  const { revenue, currency } = extractRevenue(name, e.properties);
  const conv = await db.one<{ id: string }>(
    `insert into platform.attribution_conversions (organization_id, app_id, environment_id, attribution_event_id, event_row_id, event_name, revenue, currency, occurred_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict do nothing returning id`,
    [e.organization_id, e.app_id, e.environment_id, ae?.id ?? null, e.id, name, revenue, currency, e.timestamp],
  );
  if (!conv || !ae) return;
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
    conversionId: conv.id,
    idempotencyKey: `conversion:${conv.id}`,
    matchType: ae.match_type,
    source: ae.source,
    network: ae.network,
    payload: payloadFor(e, name, `conversion:${conv.id}`, tp, ae.match_type, ae.install_at ?? ae.occurred_at, { revenue, currency }),
  });
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
