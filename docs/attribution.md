# Attribution

LeanApp attributes installs from its own event stream and its own tracking links; it does not import AppsFlyer, Adjust or Branch data. In the product this is **Acquisition (Beta)**, and it is not presented as a full mobile measurement partner (no cost import, ROAS, fraud prevention, multi-touch, view-through or ad-network-reported installs). The target design (installs and attribution as first-class records, the go.leanapp.io link service, deferred deep links, SKAN, network integrations, MVP vs later and what can't be replicated) is in [attribution architecture](attribution-architecture.md). This page describes what is built today.

**Status: engine built (phase 3, platform side).** Built: tracking links with a click redirect, install / reinstall / re-engagement matching in event processing, last-touch conversion and revenue attribution, postbacks (custom URL, tested; TikTok, Snap, Meta and Google Ads request code, **not verified with the live networks**), the attribution dashboard, settings, and SKAdNetwork / AdAttributionKit postback copies with conversion value schemas (server side). Not built: the iOS SDK applying conversion values, view-through (impression) attribution, ad-network cost import, MMP import (AppsFlyer / Adjust / Branch), first-touch and linear reporting models.

Code: `apps/platform/src/modules/attribution/` (pure logic in `pure.ts`, matching in `engine.ts`, links/settings/postback configuration in `service.ts`, delivery in `delivery.ts`, network request builders in `networks.ts`, dashboard queries in `reports.ts`). Migrations `0012_attribution.sql`, `0030_attribution_match_methods.sql` (match types). Dashboard: app → Acquisition (Beta): Overview, Sources & campaigns, Attribution, Tracking links & QR, Deep links. Settings live in Settings → Dev Ops → Attribution.

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
| 5 | Nothing matched | organic |

`deterministic` is kept for matches LeanApp verified itself: a click id that matches a click its own tracking link recorded. `reported` means the source comes only from what the install's context says (an ad-network click id or utm parameters with no recorded click behind them); it is counted as attributed but shown separately, and postbacks carry `match_type=reported`. Migration `0030_attribution_match_methods.sql` relabelled earlier context-only "deterministic" attributions as `reported`.

When the Play referrer reports `referrer_click_timestamp_seconds` older than the lookback, steps 2–3 count as organic. Clicks from another environment or another organization never match.

**One click, one install.** A click is claimed when it is first attributed or handed out by the deferred deep link API (`attribution_touchpoints.matched_at`). Probabilistic matching, in the engine and in the deferred API, only takes unclaimed clicks (row-locked while claiming, so the two paths can't race), and the engine gives an install the click the deferred API already handed it. A LeanApp click id the install itself carries still wins (step 1).

### iOS paid installs

iOS paid installs can't be attributed deterministically from the event stream: without App Tracking Transparency consent there is no IDFA, Apple forbids fingerprinting, and ad networks report iOS installs through SKAdNetwork / AdAttributionKit (aggregate, delayed, never per user) or, for Apple's own ads, Apple Search Ads attribution. LeanApp doesn't fake it: an iOS install is attributed only when it brings back a LeanApp click id (a universal link or a link the app passes on, step 1) or the opening URL's own parameters (reported, steps 2–3). Every other iOS install, paid or not, is **organic / unattributed**, and the Acquisition pages say so next to the numbers. SKAdNetwork / AdAttributionKit postback copies are reported separately (below) and never joined to installs; Apple Search Ads attribution isn't built.

**Reinstall:** an install whose `context.device.id` or `user_id` already has an install in the environment is stored as `reinstall` (still matched as above). A second `app_installed` from the same `anonymous_id` is ignored.

**Re-engagement:** when re-engagement is on (default), an `app_opened` / `deep_link_opened` carrying a LeanApp click id from a click *after* the install creates a `re_engagement` attribution event, once per click per install.

Each attribution is one row in `attribution_events` with kind, match type and key, the touchpoint, and denormalized source / medium / campaign / link / network for reporting. The matched click gets `matched_at` and the install's `anonymous_id` (so privacy export and deletion include it).

### Why probabilistic is limited

The design rule is "probabilistic only where allowed and disclosed; no fingerprinting on iOS". Apple's rules forbid fingerprinting for attribution on iOS, so iOS installs are never matched probabilistically (see [iOS paid installs](#ios-paid-installs)). On Android, IP + OS matching is a common MMP fallback, but it is personal-data processing: it is off unless the customer turns it on in Settings after disclosing it, uses a keyed hash computed at ingestion (only for `app_installed` from public SDK keys; clients can't supply it), a short window, and each click can be claimed once.

## Conversions

Events the published tracking plan marks as conversion or revenue (or, without a plan entry, the event library's conversion/revenue events; `ad_impression` excluded) are stored in `attribution_conversions` with revenue and currency (`revenue`, else `value`, `amount`, `price`; refunds count negative). Each conversion is credited to the **last touch**: the latest install, reinstall or re-engagement of that install, or of any install linked to the event's `user_id`, within the **conversion window** (default 90 days). Backend events with only a `user_id` are attributed through identity links. Conversions with no install on record are stored and reported as such.

Revenue is reported per currency as sent; no FX conversion yet.

## Postbacks

Configured per environment (app → Attribution → Postbacks). Each postback lists the events it wants (`install`, `reinstall`, `re_engagement`, conversion event names) and optionally the sources it reports. Ad-network postbacks receive only installs attributed to that network (by click id network or source name) unless sources are listed; organic events can only go to custom postbacks that opt in.

Deliveries are queued in the processing transaction (`attribution_postback_deliveries`, unique per postback and attribution) and sent by the scheduled worker (`runAttributionJobs`, called from `/api/internal/process-events` while time is left): claimed with `FOR UPDATE SKIP LOCKED` and a 2-minute lease, 10 s timeout, no redirects followed. 2xx → `succeeded`; network errors, 408, 425, 429 and 5xx retry after 1 min, 5 min, 30 min, 2 h, 12 h, then `giving_up`; other statuses and configuration errors → `failed`. The dashboard lists each postback's counts and the latest deliveries.

| Network | Request | Needs | Status |
| --- | --- | --- | --- |
| Custom URL | `GET` (or `POST` with a JSON body) to the template, macros URL-encoded: `{click_id}` `{network_click_id}` `{network_click_param}` `{event}` `{event_id}` `{revenue}` `{currency}` `{timestamp}` `{event_time}` `{install_timestamp}` `{platform}` `{source}` `{medium}` `{campaign}` `{link_code}` `{match_type}` (`deterministic`, `reported`, `probabilistic` or `organic`) `{country}`; optional Authorization header | URL | ✓ tested against a local server |
| TikTok | Events API 2.0 `POST business-api.tiktok.com/open_api/v1.3/event/track/`, `event_source: app`, `ttclid` | TikTok App ID, access token | built, **not verified with the live network** |
| Snapchat | Conversions API v3 `POST tr.snapchat.com/v3/{snap_app_id}/events`, `sc_click_id` | Snap App ID, token | built, **not verified** |
| Meta | Conversions API `POST graph.facebook.com/{v21.0}/{dataset_id}/events`, `action_source: app`, `fbc` from `fbclid` | Dataset ID, system user token | built, **not verified** (Meta app events usually also need `advertiser_id` / extinfo from the device, which the SDKs don't send yet) |
| Google Ads | `POST googleads.googleapis.com/{v18}/customers/{id}:uploadClickConversions` with `gclid` / `gbraid` / `wbraid`, OAuth refresh-token flow | Customer ID, conversion action ID, developer token, OAuth client id/secret, refresh token | built, **not verified**; sent only for events with a Google click id |

Network event names default to the network's standard events (install → `InstallApp` / `APP_INSTALL` / `MobileAppInstall`; revenue → `Purchase` / `PURCHASE`; re-engagement → `LaunchAPP` / `APP_OPEN` / `fb_mobile_activate_app`) and can be overridden with `config.event_map`.

Credentials are encrypted at rest (AES-256-GCM, `INTEGRATIONS_ENCRYPTION_KEY`), readable only by trusted server code (the tenant database role has no column access), never shown again, and refused when the key isn't configured. Postback URLs must be https and public when deployed (private and link-local addresses are blocked, DNS checked before each request).

## Reports

App → Acquisition (Beta), labelled Beta on every page with a "What Acquisition (Beta) measures" note:

- **Overview** (`/acquisition`): clicks, installs, attributed (deterministic · reported · probabilistic) and organic / unattributed shares (with the iOS count), installs per day, top 5 sources, top 5 links (click → install) and credited revenue.
- **Sources & campaigns** (`/acquisition/sources`): installs by source and campaign (deterministic, reported, probabilistic, re-engagements), and conversions and revenue by campaign per currency.
- **Attribution** (`/acquisition/attribution`): how installs were matched (deterministic, reported, probabilistic, organic / unattributed, reinstalls) with the iOS paid-install note, the matching rules in force (linking to Settings → Dev Ops → Attribution), SKAdNetwork postbacks by source identifier (linking to the SKAN setup), and what the Beta doesn't include.
- **Tracking links & QR** (`/acquisition/links`): links with clicks and installs, create / pause / resume, and each link's share URL with campaign / placement overrides and an SVG QR code (`?link={code}`). The old QR address on Deep links (`/acquisition/deep-links?link=…`) forwards here.

The numbers: clicks, installs (deterministic / reported / probabilistic / organic, of which iOS / reinstalls), re-engagements, installs per day, installs by source and campaign, conversions and revenue by source and campaign (per currency), and per-link click → install rates, for 7 / 30 / 90 days per environment. `attribution.read` sees them; `attribution.manage` edits links, postbacks and settings (owner, admin, marketer; analysts read only; developers don't see attribution).

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
- Cost import and ROAS; FX conversion of revenue.
- First-touch and linear models in reports (data supports them; last touch is what is computed).
- Live verification of the TikTok, Snap, Meta and Google postbacks: needs a customer's ad accounts, app ids and tokens.
- Management API endpoints for links and postbacks (dashboard only for now).
