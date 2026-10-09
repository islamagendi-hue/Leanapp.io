# Attribution

LeanApp attributes installs from its own event stream and its own tracking links; it does not import AppsFlyer, Adjust or Branch data. In the product this is **Acquisition (Beta)**, and it is not presented as a full mobile measurement partner (ad spend is entered by hand, by CSV, or imported from Meta, Google Ads, TikTok and Snapchat reporting APIs once a customer connects them, not yet verified live; no fraud prevention, multi-touch, view-through or ad-network-reported installs). The target design (installs and attribution as first-class records, the go.leanapp.io link service, deferred deep links, SKAN, network integrations, MVP vs later and what can't be replicated) is in [attribution architecture](attribution-architecture.md). This page describes what is built today.

**Status: engine built (phase 3, platform side).** Built: tracking links with a click redirect, install / reinstall / re-engagement matching in event processing, last-touch conversion and revenue attribution, postbacks (custom URL, tested; TikTok, Snap, Meta and Google Ads request code, **not verified with the live networks**), the attribution dashboard, settings, ad spend entered by hand or by CSV (shown with return and ROAS in Revenue by channel, and with CAC, observed LTV and LTV:CAC on Acquisition → CAC & LTV), and SKAdNetwork / AdAttributionKit postback copies with conversion value schemas (server side). Also built (migration 0034, [growth channels](channels.md)): one channel registry with customer-defined channels and rules per app, first-touch credit next to last touch, evidence labels (deterministic, observed, provider-reported, modeled) and channel performance with coverage, freshness and spend reconciliation. Ad cost import from Meta, Google Ads, TikTok and Snapchat is built in the [Integrations Center](integrations.md) (simulated tests only, not verified live). Also built (migration 0039, [attribution engine](#attribution-engine-web-touches-three-credit-views-windows-and-evidence-migration-0039)): web touches and web conversions without an install, a last non-direct touch view next to last and first touch, lookback and conversion windows per channel, method / evidence / confidence on every decision, an append-only credit history and re-crediting when touches arrive late. Not built: the iOS SDK applying conversion values, view-through (impression) attribution, MMP import (AppsFlyer / Adjust / Branch, deliberately out of scope), linear and multi-touch models.

Code: `apps/platform/src/modules/attribution/` (pure logic in `pure.ts`, matching in `engine.ts`, links/settings/postback configuration in `service.ts`, delivery in `delivery.ts`, network request builders in `networks.ts`, dashboard queries in `reports.ts`). Migrations `0012_attribution.sql`, `0030_attribution_match_methods.sql` (match types), `0031_ad_spend.sql` (ad spend, `spend.ts`), `0035_integrations_center.sql` (imported spend `origin`, delivery skip reasons and provider error details; outbound checks in `conversions.ts`). Dashboard: app → Acquisition (Beta): Overview, Sources & campaigns, Ad spend, CAC & LTV, Attribution, Tracking links & QR, Deep links. Settings live in Settings → Dev Ops → Attribution.

## Why it matters here

In the GCC, TikTok and Snapchat often drive as much mobile acquisition as Google and Meta. Many teams pay an MMP but don't trust its numbers because revenue events come from the app rather than the server. LeanApp's angle: attribution that is fed by the same validated event stream, with revenue confirmed by the backend.

## Everything is per environment

Links, clicks, attributions, conversions and postbacks belong to one environment. A production link records production clicks, and only installs sent with a production key can match them. Settings are per app.

## Install referrer (Android)

The Android SDK reads the Google Play Install Referrer once per install and sends it on every event as `context.campaign.install_referrer` (raw referrer string), with `referrer_click_timestamp_seconds`, `install_begin_timestamp_seconds` and `google_play_instant`. utm_* and click ids (including LeanApp's `click_id`) parsed from it are also sent as the first touch in `context.attribution`. Deep links captured by the native SDKs add `context.attribution.deep_link_url`. See [SDK](sdk.md).

## Tracking links

`https://api.leanapp.io/l/{code}` (8 url-safe characters). Each link has a name, source, medium, campaign, ad group, creative, an App Store URL, a Google Play URL, a web fallback and an optional deep link path. Ad networks can override campaign / ad group / creative per ad with `utm_campaign`, `utm_term`, `utm_content` (or `campaign`, `ad_group`, `creative`) on the link, and their click id (`gclid`, `gbraid`, `wbraid`, `fbclid`, `ttclid`, `ScCid`, `twclid`, `msclkid`, `li_fat_id`) is stored with the click.

On a click the redirect:

1. picks the destination from the user agent: iPhone/iPad → App Store; Android → Google Play with `referrer=` carrying `click_id`, `utm_*` and `deep_link`; anything else → web fallback with `click_id` and `utm_*` appended. A missing destination falls back to the next one;
2. records a touchpoint (`attribution_touchpoints`, `kind = 'click'`) with a generated click id `lac_…`, the link's labels, the user agent (truncated), OS and major version, the referring host, coarse country from `x-vercel-ip-country` when present, and a **keyed hash** of the IP (HMAC-SHA256 with `ATTRIBUTION_IP_HASH_SECRET`, scoped per app). The raw IP is never stored. IP hashes and user agents are cleared after 7 days by the scheduled worker;
3. does **not** record (but still redirects) crawlers and link unfurlers (Facebook, WhatsApp, Slack, Twitter, Telegram, Google, scripted clients, …), prefetches (`Purpose` / `Sec-Purpose: prefetch`), `HEAD` requests, paused links, and senders over the rate limit (20 clicks per visitor per link per minute, 6,000 per environment per minute; configurable). The visitor always reaches the store.

Responses are `302` with `Cache-Control: no-store`, `X-Robots-Tag: noindex`, `Referrer-Policy: no-referrer`; unknown codes are `404`. Links are created only by members with `attribution.manage`, and destinations must be https.

## Matching (installs)

Runs inside event processing (`modules/processing` step 5), once per event, for `app_installed`. Other events cost nothing except opens carrying a LeanApp click id and conversion events (a few indexed lookups each). In order of confidence, within the app's **click lookback** (default 7 days, 1–90):

| # | Signal | `match_type` / `match_key` |
| --- | --- | --- |
| 1 | LeanApp click id from the Play install referrer, a deep link URL, or `context.attribution.click_id`, found among the clicks LeanApp's own links recorded. Else the click the [deferred deep link API](deep-links.md) already handed this install by click id | deterministic / `install_referrer`, `deep_link`, `click_id` |
| 2 | Ad-network click id in the install's context. Matched to a click a LeanApp link recorded that carried the same id → deterministic. Otherwise only the install reports it: a touchpoint is created from the context (network from the click id, campaign from `utm_*`) → reported | deterministic or reported / `gclid`, `ttclid`, `ScCid`, `fbclid`, … |
| 3 | `utm_source` captured from the link that installed or opened the app (Play referrer without a LeanApp click id, or deep link). Self-reported by the install; nothing LeanApp recorded verifies it | reported / `install_referrer`, `utm_parameters` |
| 4 | **Probabilistic**, only when the app turns it on (off by default): the click a probabilistic deferred deep link lookup already handed this install, else an *unclaimed* Android link click from the same IP hash and Android major version within the probabilistic window (default 24 h, max 7 days) and the click lookback. Never used for iOS or unknown platforms. Reported separately everywhere | probabilistic / `ip_ua` (`ip_os` when it came from the deferred lookup) |
| 5 | Nothing matched. The match key says why when the install's parameters did: the store's own organic referrer (Play `utm_medium=organic`) → `store_organic`; direct / none → `direct`; organic from an unrecognised source → `organic_other`; otherwise none (unattributed) | organic / `store_organic`, `direct`, `organic_other` or null |

`deterministic` is kept for matches LeanApp verified itself: a click id that matches a click its own tracking link recorded. `reported` means the source comes only from what the install's context says (an ad-network click id or utm parameters with no recorded click behind them); it is counted as attributed but shown separately, and postbacks carry `match_type=reported`. Migration `0030_attribution_match_methods.sql` relabelled earlier context-only "deterministic" attributions as `reported`.

When the Play referrer reports `referrer_click_timestamp_seconds` older than the lookback, steps 2–3 count as organic. Clicks from another environment or another organization never match.

**One click, one install.** A click is claimed when it is first attributed or handed out by the deferred deep link API (`attribution_touchpoints.matched_at`). Probabilistic matching, in the engine and in the deferred API, only takes unclaimed clicks (row-locked while claiming, so the two paths can't race), and the engine gives an install the click the deferred API already handed it. A LeanApp click id the install itself carries still wins (step 1).

### iOS paid installs

iOS paid installs can't be attributed deterministically from the event stream: without App Tracking Transparency consent there is no IDFA, Apple forbids fingerprinting, and ad networks report iOS installs through SKAdNetwork / AdAttributionKit (aggregate, delayed, never per user) or, for Apple's own ads, Apple Search Ads attribution. LeanApp doesn't fake it: an iOS install is attributed only when it brings back a LeanApp click id (a universal link or a link the app passes on, step 1) or the opening URL's own parameters (reported, steps 2–3). Every other iOS install, paid or not, is **unattributed** (never counted as organic), and the Acquisition pages say so next to the numbers. SKAdNetwork / AdAttributionKit postback copies are reported separately (below) and never joined to installs. Apple Search Ads installs are the exception Apple allows: when Apple's AdServices API attributes an install to one of its campaigns, the unattributed install becomes provider-reported Apple Search Ads ([Apple Search Ads (AdServices)](#apple-search-ads-adservices-provider-reported-installs-migration-0039b)).

**Reinstall:** an install whose `context.device.id` or `user_id` already has an install in the environment is stored as `reinstall` (still matched as above). A second `app_installed` from the same `anonymous_id` is ignored.

**Re-engagement:** when re-engagement is on (default), an `app_opened` / `deep_link_opened` carrying a LeanApp click id from a click *after* the install creates a `re_engagement` attribution event, once per click per install.

Each attribution is one row in `attribution_events` with kind, match type and key, the touchpoint, and denormalized source / medium / campaign / link / network for reporting. The matched click gets `matched_at` and the install's `anonymous_id` (so privacy export and deletion include it).

### Why probabilistic is limited

The design rule is "probabilistic only where allowed and disclosed; no fingerprinting on iOS". Apple's rules forbid fingerprinting for attribution on iOS, so iOS installs are never matched probabilistically (see [iOS paid installs](#ios-paid-installs)). On Android, IP + OS matching is a common MMP fallback, but it is personal-data processing: it is off unless the customer turns it on in Settings after disclosing it, uses a keyed hash computed at ingestion (only for `app_installed` from public SDK keys; clients can't supply it), a short window, and each click can be claimed once.

## Conversions

Events the published tracking plan marks as conversion or revenue (or, without a plan entry, the event library's conversion/revenue events; `ad_impression` excluded) are stored in `attribution_conversions` with revenue and currency (`revenue`, else `value`, `amount`, `price`; refunds count negative). Each conversion is credited to the **last touch**: the latest install, reinstall, re-engagement or web touch of that install, or of any install linked to the event's `user_id`, within the **conversion window** (default 90 days, per channel when set). Backend events with only a `user_id` are attributed through identity links. Conversions with no touch on record are stored and reported as unattributed. First touch and last non-direct touch are recorded next to it; see [three credit views](#three-credit-views).

Revenue is reported per currency as sent; no FX conversion yet.

Since migration 0034 each conversion also records its **first touch** (`first_attribution_event_id`): the person's earliest install, reinstall or re-engagement within the same conversion window. Reports offer both models; see [growth channels](channels.md#attribution-models-and-windows).

## Attribution engine: web touches, three credit views, windows and evidence (migration 0039)

LeanApp's own analytics are the source of truth: everything below runs on the event stream LeanApp collects, with no ad account connected. Ad platforms are optional integrations ([integrations](integrations.md)); their reports are imported as provider-reported numbers and never decide LeanApp's attribution.

Code: `attribution/pure-credit.ts` (pure decisions, unit-tested in `pure-credit.test.ts`) and `attribution/engine.ts` (database steps, run once per event in event processing). Migration `0039_attribution_engine.sql` is additive: new columns, one new table, widened check constraints.

### Touches

A **touch** is one stored row in `attribution_events`, always appended, never overwritten:

| Kind | When | Raw touchpoint |
| --- | --- | --- |
| `install` / `reinstall` | `app_installed` (see [Matching](#matching-installs)) | the recorded link click, or a `context` touchpoint made from what the install carried |
| `re_engagement` | `app_opened` / `deep_link_opened` with a newer LeanApp click | the recorded link click |
| `web_touch` (new) | a web event (`platform = web`) whose `context.attribution` carries a UTM parameter, a click id, or an **external** referrer (another site than the landing page) | `attribution_touchpoints.kind = 'web'`: landing page **without its query string or fragment**, referring host only, campaign / ad set / ad ids, the click ids, and the names of the keys that were present |

Web touch rules:

- **No evidence, no touch.** A web event with no UTM parameter, no click id and no external referrer creates nothing. LeanApp never invents a source or a click id.
- **Matching.** A LeanApp click id (`click_id`, appended by tracking links to the web destination) or an ad-network click id that a LeanApp link recorded makes the touch `deterministic`; the link's own labels win. Otherwise the touch is `reported` (`match_key` = the click id parameter, `utm_parameters`, or `referrer` for a referrer alone). UTM parameters that say direct (`utm_source=(direct)`, `utm_medium=(none)`) make a `direct` touch (`match_type organic`, `match_key direct`).
- **De-duplication.** The same campaign evidence (a hash of source, medium, campaign, term, content, `utm_id` and click ids, or the referring host when there is nothing else: `touch_signature`) from the same visitor in the same session or within 30 minutes is one visit. The SDK repeats the context on the first event of each session and on its landing event; that is counted once. A re-sent first touch (`touch=first`) is recorded once ever. Duplicate events (same `event_id`) are already dropped at ingestion.
- **Consent.** Attribution context is removed at ingestion when the person denied the `attribution` purpose; an event that itself says `context.consent.attribution = false` makes no touch either.
- **Postbacks.** A web touch queues no postback of its own; conversions credited to it do (below).

The SDK side (automatic capture of the landing URL, referrer, UTMs and click ids in the JS SDK, typed `context.attribution` keys) is described in [SDK](sdk.md) and [events](events.md).

### Method, evidence and confidence

Every touch records how it was established (`method`), a `confidence` level and an `evidence` object (`describeMatch` in `pure-credit.ts`):

| Method | Match | Confidence | Limitations recorded |
| --- | --- | --- | --- |
| `leanapp_click`, `deferred_deep_link` | a LeanApp click id of a click LeanApp's link recorded | high | none |
| `network_click_recorded` | an ad-network click id our link recorded on the click | high | `click_id_not_proof_of_ad` for fbclid / twclid |
| `network_click_reported` | an ad-network click id only the install / visit carried | medium (low for fbclid / twclid) | `self_reported`, `click_id_not_proof_of_ad` |
| `play_install_referrer` | campaign parameters from the Play Install Referrer | medium | none |
| `utm_parameters` | UTM parameters the install / visit carried | medium | `self_reported` |
| `referrer` | only an external referring site | low | `referrer_only` (browsers strip or shorten referrers) |
| `probabilistic_ip_os` | opt-in Android IP-hash + OS match | low | `modeled` |
| `adservices` | Apple's AdServices API attributed the iOS install to an Apple Search Ads campaign (`match_type provider_reported`) | high (medium for an impression) | `provider_reported`, `view_through` for impressions |
| `store_organic`, `direct`, `organic_parameters` | the store referrer / parameters say organic or direct | medium / medium / low | `self_reported` where the parameters are the only source |
| `none` | nothing observed or matched (unattributed) | none | `no_evidence`, plus `ios_no_click_id` on iOS |

`evidence` holds the channel under the built-in rules, the click lookback applied, the names of the signals seen (never their values), the time of the underlying click or visit, the landing and referring hosts of web touches and the limitations. It never holds raw IPs, secrets or full URLs. fbclid is appended by Facebook and Instagram to organic link shares too, so a touch resting on fbclid alone is low confidence and says so. Rows stored before 0039 have no method; their `match_type` / `match_key` still say how they were matched.

### Three credit views

Each conversion gets three credits among the person's touches (installs, reinstalls, re-engagements and web touches; the person is found by install id, `user_id` and identity links, so a web visit before sign-up and an app purchase after it are joined), each touch counting only within its channel's conversion window:

- **Last touch** (`attribution_event_id`): the latest touch, whatever it was.
- **First touch** (`first_attribution_event_id`): the earliest touch.
- **Last non-direct touch** (`last_non_direct_attribution_event_id`, new): the latest touch with a known source. **Direct, organic-without-campaign and unattributed touches** (match type `organic`, or a touch that classifies as `direct` / `unattributed`) never take this credit from a known earlier source. When no touch in the window has a known source, it falls back to the last touch and the evidence says `last_non_direct_fallback: true`. An unrecognised source (campaign data no rule knows) is an explicit **unknown** source and keeps its credit; it is not treated as direct.

`credit_evidence` on the conversion says which touches were credited, their channels and windows, how many touches were considered or fell outside their window, and the status: `credited`, `outside_window` or `no_touch`. Conversions with no touch are stored and reported as **Unattributed**, never as organic or direct. Every credit is also appended to `attribution_conversion_credits` (reason `initial`).

Postbacks for a conversion go to the network of its **last non-direct** touch: a later direct visit or organic reinstall no longer hides a paid conversion from the network that drove it. Sending a conversion to a network never guarantees the network attributes it to an ad.

The reports offer all three (Sources & campaigns → Credit; Settings → Dev Ops → Attribution → Reports open with). Conversions recorded before 0039 have no last-non-direct record; that view credits them by last touch and counts them (`coverage.lastNonDirectFallback`).

### Apple Search Ads (AdServices): provider-reported installs (migration 0039b)

Apple's AdServices API is the only per-install signal Apple offers for its own ads. The iOS SDK sends the token, the worker looks it up and stores Apple's answer (`adservices_attributions`, see [integrations](integrations.md#apple-search-ads-attribution-adservices)), and the engine then applies an `attributed` answer (`applyAdServicesAttribution` in `engine.ts`, called by `processAdServicesLookups`):

- **Which install.** The install / reinstall row of the same environment and `anonymous_id`. Only an install **nothing matched** (`match_type organic`: an unattributed iOS install) is changed. A LeanApp click match (deterministic), reported parameters or an earlier upgrade are **never overridden**; Apple's answer stays stored for them.
- **Upgraded in place, once.** The install keeps its id, so installs are never double-counted. It becomes `match_type provider_reported`, `match_key adservices`, `method adservices`, `source apple_search_ads` (Apple Search Ads channel, paid), `campaign` = Apple's campaign id. A touchpoint (`provider apple_adservices`, `kind context`) holds Apple's campaign, ad group and ad ids; `evidence.apple` holds the campaign, ad group, keyword and ad ids, claim type, conversion type and country, and `evidence.upgraded_from` keeps what the row was before (match type, method, confidence, source, touchpoint) with `upgraded_at`. The update only applies while the row is still `organic`, so it happens once.
- **Confidence.** `high` when Apple reports a tap (claim type Click, or none given), `medium` with the `view_through` limitation when Apple credits an impression. The limitation `provider_reported` is always recorded: LeanApp saw no click of its own. Evidence label: provider-reported.
- **Conversions.** The person's conversions after the install (recorded since 0039) are re-credited through the late-touch path; each changed credit is appended to `attribution_conversion_credits` with reason `provider_reported`. Typically the last non-direct credit turns from a fallback on the unattributed install into Apple Search Ads. Postbacks are queued for conversions that get a known source this way (idempotent per postback).
- **Order.** When Apple's answer is stored before the install is processed, the install step uses it directly (after LeanApp click ids and the install's own parameters, before anything modeled).
- **"not_attributed"**, expired, failed or skipped lookups change nothing.

Reports: Apple Search Ads installs count as attributed (`attributionOverview` totals gain `provider_reported`; in the channel report they carry the provider-reported evidence). This rests on Apple's documented API and is tested with a fake fetch; it is **not verified against the live AdServices API** (see [integrations](integrations.md) for the owner's verification step).

### Delayed and out-of-order events

Events are processed in arrival order, not event-time order. When a touch arrives after conversions it precedes (an install batch flushed late, a web touch replayed by the SDK), the engine re-credits the person's conversions recorded since 0039 whose credits change, and appends the new credit to `attribution_conversion_credits` with reason `late_touch`; the earlier credit stays in the history. A conversion that had no credited touch before queues its postbacks then. Ingestion still rejects events more than 31 days old and clamps future timestamps ([events](events.md)); re-crediting is bounded by the longest conversion window.

### Windows per channel

The app-wide click lookback (1–90 days) and conversion window (1–730 days) apply to every channel unless Settings → Dev Ops → Attribution → **Windows per channel** sets a different one for a channel (the paid networks are listed; `attribution_settings.window_overrides`, validated by `validateWindowOverrides`, unknown channels and out-of-range values refused). The engine searches with the longest window and then holds each click or touch to its own channel's window (channel by the built-in rules). Ad networks count conversions in their own reports with their own windows; LeanApp neither reads nor changes those, and never assumes they match its own.

### Source classes

Every channel in the report carries a `sourceClass`: `paid`, `organic` (search, social, store discovery, content), `referral` (referral sites, referral programs, partners, affiliates, offline), `owned` (email, SMS, push, WhatsApp, in-app, website), `custom`, `direct`, `unknown` (data no rule recognises) or `unattributed` (nothing observed).

### Tests

- Unit: `attribution/pure-credit.test.ts` (windows per channel, weak touches, credit picking incl. ties and skew, decision descriptions, web touch parsing incl. missing UTMs, internal referrers, consent and de-duplication signatures), `channels/report-pure.test.ts` (web touches by channel, last non-direct fallback, source classes, unattributed conversions).
- Integration (`test/attribution.int.test.ts`, describe "attribution engine"): web sign-ups and purchases without an install; precedence (direct visit and organic reinstall vs a paid source); method / evidence / confidence; missing UTMs; unknown sources; duplicates; delayed and out-of-order events with credit history and the 31-day rejection; per-channel click lookback and window validation; tenant isolation of touches, conversions, credit history, reports and settings.

### Owner actions

None to use it: the migration runs with the others (`npm run db:migrate`), and the engine needs no credentials or environment variables. Optional: choose **Last non-direct touch** under Settings → Dev Ops → Attribution → Reports open with, and set windows per channel there if a channel needs one different from the app-wide window. Web touches need the web SDK to send `context.attribution` (landing URL, referrer, UTMs and click ids) and `platform: web`.

## Postbacks

Configured per environment (app → Attribution → Postbacks). Each postback lists the events it wants (`install`, `reinstall`, `re_engagement`, conversion event names) and optionally the sources it reports. Ad-network postbacks receive only installs attributed to that network (by click id network or source name) unless sources are listed; organic events can only go to custom postbacks that opt in.

Deliveries are queued in the processing transaction (`attribution_postback_deliveries`, unique per postback and attribution) and sent by the scheduled worker (`runAttributionJobs`, called from `/api/internal/process-events` while time is left): claimed with `FOR UPDATE SKIP LOCKED` and a 2-minute lease, 10 s timeout, no redirects followed. Before sending, Meta, Snapchat and TikTok deliveries are checked (`conversions.ts`): an end user whose attribution consent is denied is `skipped` (`consent_denied`), an event with no key the network can match on is `skipped` (`no_match_key`), and a body that fails the network's documented rules (event id, currency, 7-day event window, Meta `app_data` / `user_data`) is `failed` without a request. Each request carries the payload's stable event id so networks can deduplicate retries. 2xx → `succeeded`; network errors, 408, 425, 429 and 5xx retry after 1 min, 5 min, 30 min, 2 h, 12 h, then `giving_up`; other statuses and configuration errors → `failed`. The dashboard lists each postback's counts and the latest deliveries with the skip reason, the provider's error code and trace id, and a summary of the request without credentials or query strings.

| Network | Request | Needs | Status |
| --- | --- | --- | --- |
| Custom URL | `GET` (or `POST` with a JSON body) to the template, macros URL-encoded: `{click_id}` `{network_click_id}` `{network_click_param}` `{event}` `{event_id}` `{revenue}` `{currency}` `{timestamp}` `{event_time}` `{install_timestamp}` `{platform}` `{source}` `{medium}` `{campaign}` `{link_code}` `{match_type}` (`deterministic`, `reported`, `probabilistic` or `organic`) `{country}`; optional Authorization header | URL | ✓ tested against a local server |
| TikTok | Events API 2.0 `POST business-api.tiktok.com/open_api/v1.3/event/track/`, `event_source: app`, `ttclid` | TikTok App ID, access token | built, **not verified with the live network** |
| Snapchat | Conversions API v3 `POST tr.snapchat.com/v3/{snap_app_id}/events`, `sc_click_id` | Snap App ID, token | built, **not verified** |
| Meta | Conversions API `POST graph.facebook.com/{v21.0}/{dataset_id}/events`, `action_source: app`, `fbc` from `fbclid` | Dataset ID, system user token | built, **not verified**; `user_data` carries `anon_id` (the LeanApp install id) and `fbc` when present (Meta app events usually also need extinfo from the device, which the SDKs don't send yet) |
| Google Ads | `POST googleads.googleapis.com/{v18}/customers/{id}:uploadClickConversions` with `gclid` / `gbraid` / `wbraid`, OAuth refresh-token flow | Customer ID, conversion action ID, developer token, OAuth client id/secret, refresh token | built, **not verified**; sent only for events with a Google click id |

Network event names default to the network's standard events (install → `InstallApp` / `APP_INSTALL` / `MobileAppInstall`; revenue → `Purchase` / `PURCHASE`; re-engagement → `LaunchAPP` / `APP_OPEN` / `fb_mobile_activate_app`) and can be overridden with `config.event_map`.

Credentials are encrypted at rest (AES-256-GCM, `INTEGRATIONS_ENCRYPTION_KEY`), readable only by trusted server code (the tenant database role has no column access), never shown again, and refused when the key isn't configured. Postback URLs must be https and public when deployed (private and link-local addresses are blocked, DNS checked before each request).

## Reports

App → Acquisition (Beta), labelled Beta on every page with a "What Acquisition (Beta) measures" note:

- **Overview** (`/acquisition`): clicks, installs, attributed (deterministic · reported · probabilistic) and unattributed shares (with the iOS count, and the organic-from-store-referrer and direct counts), the top channels, installs per day, top 5 sources, top 5 links (click → install), coverage and freshness, and credited revenue.
- **Sources & campaigns** (`/acquisition/sources`): the **Channels** table (clicks, installs with evidence, new users, activation and D7 retention when the growth model is on, sign-ups, purchases, revenue, spend, CPI, CPA; last or first touch) with coverage, freshness and spend reconciliation ([growth channels](channels.md#channel-analytics)), then installs by source and campaign (deterministic, reported, probabilistic, re-engagements), and conversions and revenue by campaign per currency.
- **Ad spend** (`/acquisition/spend`): spend per day, source, optional campaign and currency, added one day at a time or pasted / uploaded as CSV (`date,source,campaign,currency,amount`, header optional), with a list of entries and delete. See [Ad spend](#ad-spend).
- **CAC & LTV** (`/acquisition/channels`): per channel, spend, new users, paying users, CAC, revenue, LTV and LTV:CAC, per currency, with a bar of new and paying users. See [CAC and LTV by channel](#cac-and-ltv-by-channel).
- **Attribution** (`/acquisition/attribution`): how installs were matched (deterministic, reported, probabilistic, organic from the store referrer, direct, unknown source, unattributed, reinstalls), what each number rests on (evidence labels) with the iOS paid-install note, the matching rules in force (linking to Settings → Dev Ops → Attribution), SKAdNetwork postbacks by source identifier (linking to the SKAN setup), and what the Beta doesn't include.
- **Tracking links & QR** (`/acquisition/links`): links with clicks and installs, create / pause / resume, and each link's share URL with campaign / placement overrides and an SVG QR code (`?link={code}`). The old QR address on Deep links (`/acquisition/deep-links?link=…`) forwards here.

The numbers: clicks, installs (deterministic / reported / probabilistic / organic, of which iOS / reinstalls), re-engagements, installs per day, installs by source and campaign, conversions and revenue by source and campaign (per currency), and per-link click → install rates, for 7 / 30 / 90 days per environment. `attribution.read` sees them; `attribution.manage` edits links, postbacks and settings (owner, admin, marketer; analysts read only; developers don't see attribution).

## Ad spend

The MVP's cost model (`platform.ad_spend_daily`, migration 0031; `modules/attribution/spend.ts`): one row per environment, calendar day in the app's timezone, `source`, `campaign` ('' for the whole source), `currency` (ISO 4217) and `amount` (numeric, ≥ 0). Saving the same day, source, campaign and currency again replaces the amount; a CSV row does the same, and a later row in one CSV wins over an earlier one. Days after today (app timezone) are refused, and so are the channels that have no paid source (`organic`, `(unknown)`, `(no install on record)`). A CSV with any wrong row saves nothing and lists each wrong line (at most 5,000 rows, 1 MB).

`source` must be written exactly as Acquisition shows the attribution `source` (e.g. `tiktok`): the Revenue report broken down by **Channel** sums spend per source and currency over the report's days and shows, next to each channel's revenue, **Spend**, **Return** (gross revenue − spend, can be negative) and **ROAS** (gross revenue ÷ spend, e.g. `3.20×`), each blank when the channel has no spend. Sources with spend but no revenue get their own row. Spend is only compared with revenue in the same currency: nothing is converted or added across currencies. With an audience filter, spend is left out (it can't be split by audience). Saving or deleting spend drops the environment's cached report results.

Changing spend needs `attribution.manage` and is audited (`attribution.spend_saved`, `attribution.spend_imported`, `attribution.spend_deleted`); reading it needs `analytics.read` (the page also needs `attribution.read`, like the rest of Acquisition). Imported spend (`origin = import`, from the [Integrations Center](integrations.md#ad-reporting-import-inbound)) lands in the same table with the connection's id and is shown with an Imported pill; a manual or CSV row for the same day, source, campaign and currency wins and is never overwritten by an import. Not built: CPI, spend per ad set, ad or country, and FX conversion.

### CAC and LTV by channel

Acquisition → CAC & LTV (`modules/attribution/economics.ts`, arithmetic in `economics-pure.ts`) puts cost next to what buyers paid, for the range picked (preset or custom days, app timezone) and an **LTV window** of 7, 30, 60, 90 (default), 180 or 365 days. It uses two groups of people, both chosen by the range:

- People are stitched as in Analytics (user_id, else the one user the install is linked to, else the anonymous id). A person's **channel** is the source of their first install or reinstall on record (a source, `organic`, `(unknown)`, or `(no install on record)`), in both groups.
- **New users** (the CAC group): people whose first install or reinstall falls in the range. A second device is not a new user.
- **Spend**: the spend entered for that source over the range's days, per currency (sources match exactly, as in Revenue by channel).
- **CAC** = spend ÷ new users, in the spend's currency; "—" without spend or new users.
- **Buyers** (the LTV group): people whose first purchase ever — their first revenue transaction that isn't a refund, by the Revenue report's rules — falls in the range. A person installed long before the range can be a buyer.
- **Revenue in window**: each buyer's net revenue (gross − refunds) in `[first purchase, first purchase + N days)`, per currency.
- **LTV** = revenue in window ÷ buyers, per currency. It is observed revenue, not a forecast. A buyer whose N days haven't passed yet counts with what they paid so far; the page shows how many buyers have had the full window and marks the rest **still maturing**.
- **LTV over time**: LTV at the first day (first 24 hours) and at day 7, 30, 60… up to N. Each point divides the revenue in the first `max(d, 1)` days by only the buyers who have had that long, and shows that count.
- **LTV:CAC** = LTV ÷ CAC, only when the spend and all of the channel's buyers' revenue are in one currency; otherwise "—" with a note. The two numbers come from different groups (installs in the range, first purchases in the range). Nothing is converted between currencies.
- **Buyers with the most revenue**: up to 50 of the buyers (a row per person and currency) with channel, first purchase date, purchases and revenue in window, linked to their profile for people with `users.read`.

It needs `attribution.read` and `analytics.read`, and runs through the report cache (kind `channel_economics`, cache version 4).

## SKAdNetwork / AdAttributionKit

Code: `skan.ts` (parsing and Apple signature verification, pure), `skan-schema.ts` (conversion value schema, pure), `skan-service.ts` (receiver, settings, schema, reports). Migration `0016_skan.sql`. Dashboard: app → Attribution → SKAdNetwork; the overview lists postbacks per network and source identifier.

**Receiving postback copies.** The app sets `NSAdvertisingAttributionReportEndpoint` (SKAdNetwork) and `AdAttributionKit → AttributionCopyEndpoint` in Info.plist to `https://<domain>`. Apple uses only the registrable domain and posts to `/.well-known/skadnetwork/report-attribution/` and `/.well-known/appattribution/report-attribution/` (trailing slash; `next.config.ts` sets `skipTrailingSlashRedirect` and `proxy.ts` keeps the usual redirect for every other path). `SKAN_REPORT_DOMAIN` names the domain whose root routes those paths to this deployment; customers on their own domain forward the two paths unchanged.

**Verification.** SKAdNetwork 2.1–4.x: ECDSA P-256 / SHA-256 over the version's fields joined by U+2063 (4.x: version, ad-network-id, source-identifier, app-id, transaction-id, redownload, source-app-id or source-domain when present, fidelity-type, did-win, postback-sequence-index; 3.0 and 2.x use campaign-id and fewer fields), with Apple's published key (constant with its source URL in `skan.ts`). Versions 1.0 / 2.0 (other keys) are refused. AdAttributionKit: compact JWS, `ES256`, key chosen by `kid` (`apple-cas-identifier/0` production, `apple-development-identifier/0|1` development). Tests use Apple's own signed examples plus locally generated key pairs for every version layout. Postbacks that fail verification get `400` and are never stored. Apple doesn't sign conversion values, country or interaction type; the first copy of a transaction wins (duplicates by `transaction-id` / `postback-identifier` are discarded).

**Routing.** By App Store id (`attribution_settings.ios_app_store_id`, unique across LeanApp: an id claimed by another app is refused and needs support). SKAdNetwork and production AdAttributionKit postbacks go to the production environment, development-key AdAttributionKit postbacks to development. An unclaimed id gets `404` so the device keeps retrying (up to 9 days). Rate limits: `SKAN_POSTBACKS_PER_IP_PER_MINUTE` (120), `SKAN_POSTBACKS_PER_APP_PER_MINUTE` (6,000).

**Stored** (`skan_postbacks`): framework, version, ad network id, source identifier (or campaign id), source app id / domain, redownload / conversion type, fidelity, did-win, sequence index, fine and coarse value, country, and the postback as received. Postbacks have no user or device id and are never joined to users or counted as installs.

**Conversion value schema** (per app, `skan_conversion_schemas`, edited as JSON on the SKAdNetwork page, served by `GET /v1/skan/conversion-schema` with the SDK key). Rules `{ window: 0|1|2, event?, min_revenue?, max_revenue?, fine? (0–63, window 0 only), coarse? (low|medium|high), lock? }`; windows are Apple's 0–48 h, 48 h–7 days, 7–35 days after install; a rule matches when the event has its name and the window's cumulative revenue in the schema currency is within `[min, max)`; values only go up within a window; `lock` locks the window. `evaluateConversion()` is the reference implementation, tested with `test/fixtures/conversion-schema-vectors.json`. **The iOS SDK does not apply schemas yet.**

The App Store id and the SKAdNetwork ids from the app's `SKAdNetworkItems` are stored per app; LeanApp can't read Info.plist, so the list is what the customer pasted.

## What the SDKs must send

See [SDK: attribution context](sdk.md#attribution-context): `app_installed` with the Play install referrer (Android), the deep link URL and click ids in `context.attribution` / `context.campaign`.

## Not built yet

- iOS SDK support for conversion values (calling `SKAdNetwork.updatePostbackConversionValue` / AdAttributionKit per the schema).
- View-through attribution: needs impression data from ad networks. `attribution_settings.view_lookback_hours` exists but is **not used** by anything yet; the settings page says so.
- Live verification of ad cost import (built, tested against mocked APIs only), CPI, predicted LTV; FX conversion of revenue and spend.
- Linear and multi-touch models (last touch, first touch and last non-direct touch are built).
- Re-crediting conversions recorded before migration 0039 when a late touch arrives (they keep their stored credit).
- Live verification of the TikTok, Snap, Meta and Google postbacks: needs a customer's ad accounts, app ids and tokens.
- Management API endpoints for links and postbacks (dashboard only for now).
