# Native attribution architecture (LeanApp as its own MMP)

_Decided 2026-10-06 by the product owner._ LeanApp provides analytics, attribution, deep linking and engagement in one platform. It does **not** import data from AppsFlyer, Adjust or Branch. Attribution is a first-class object: every user and every event can answer "where did this user come from?" and "which campaign produced this revenue?" from LeanApp's own data.

There is no import or migration product for other MMPs, now or later. A customer that keeps AppsFlyer, Adjust or Branch running may at most send their live callbacks as an optional extra signal (deferred until after the attribution core, Phase 2); LeanApp's own attribution never depends on them.

The chain every part must keep intact:

```
Ad / link click (or impression) → go.leanapp.io link → landing / store → install → first open
  → attribution record → user (anonymous → identified) → events → revenue → campaign reporting
```

## 1. What already exists and is reused

| Component | Where | Reused as |
| --- | --- | --- |
| Tracking links with click capture before redirect, bot/prefetch filtering, keyed IP hash, coarse country | `modules/attribution/service.ts`, `/l/{code}` | The core of the link service; moved to the `go.leanapp.io` host with richer metadata |
| Touchpoints (clicks and install context, network click ids) | `attribution_touchpoints` | Unchanged role; gains `impression` kind and ad hierarchy ids |
| Install / reinstall / re-engagement matching in event processing | `modules/attribution/engine.ts` (processor step 5) | Becomes the attribution service's matcher; adds first-touch, confidence, reattribution windows |
| Conversions with revenue, last-touch credit | `attribution_conversions` | Kept; every event also gets a direct attribution reference |
| Ad-network postbacks (custom URL tested; Meta, TikTok, Snap, Google request code) | `attribution_postbacks`, delivery queue | Kept for sending installs/conversions back to networks |
| Identity stitching (anonymous → user, shared-device rule) | processing, `identity_links` | The identity backbone attribution hangs off |
| Event pipeline, idempotency, per-environment isolation, RLS | ingestion, processing | Unchanged; production attribution never mixes with development |
| Revenue per currency, cohorts, retention, saved reports | `modules/analytics` | Reports grouped by attribution dimensions (source, campaign, country) |
| Consent per purpose (including `attribution`) and suppressions | `modules/privacy/consent.ts` | Attribution and ad identifiers only when consent allows |
| JS, Android, iOS, Flutter SDKs: queue, retries, Play install referrer, deep-link capture | `sdks/*` | Extended with install id, deferred links, attribution callback, SKAN |
| Deep-link work in progress (AASA / assetlinks, resolve, deferred lookup, in-app-browser page, QR) | branch `feat/deeplinks` | Folded into the link service below |

## 2. New services and data model

### Services (all in `apps/platform`, same deployment)

1. **Link service** (`go.leanapp.io`): link CRUD, click capture, routing (Universal Links, App Links, custom schemes, store, web, desktop), AASA / assetlinks hosting, in-app-browser interstitial, QR codes, link context storage for deferred deep linking.
2. **Attribution service**: install registration, matching (deterministic → limited probabilistic → network claims → organic), first/last-touch records, confidence, reattribution and re-engagement windows, stamping attribution onto events.
3. **Network connector service**: per-network adapters for self-attributing networks and ad platforms (claims, cost, postbacks), each behind its own credentials and verified status.
4. **SKAN service**: conversion-value schemas, iOS postback receiver with Apple signature verification, aggregate reporting. Never joined to users.
5. **Attribution reporting**: installs, paid/organic, CPI, CAC, ROAS, LTV, retention by source, SKAN, all per environment.

### Data model (new or changed tables)

| Table | Holds | Key points |
| --- | --- | --- |
| `installs` | One row per app install: SDK-generated `install_id`, anonymous id, platform, app version, OS, country, store, first_open_at, reinstall flag, previous install | The anchor of the chain. Today an install is an `attribution_events` row keyed on anonymous id |
| `attributions` (evolves `attribution_events`) | The attribution record per install and per re-engagement: kind, model results (`first_touch_id`, `last_touch_id`), media source, channel, campaign / ad set / ad (ids + names), creative, country, platform, app version, `match_type` (deterministic, probabilistic, network_claim, organic), `confidence` (0–1 with a reason), `source_of_truth` (leanapp, network claim, Apple Search Ads), windows used, `reattributed_from` | One current attribution per install, history kept |
| `events.attribution_id`, `events.install_id` | Every processed event points to the attribution in force when it happened | Answers "which campaign produced this revenue" with no re-matching at query time |
| `app_users.first_attribution_id`, `latest_attribution_id` | Per person | "Where did this user come from" in one lookup |
| `attribution_touchpoints` (extended) | Clicks, impressions, context; ad hierarchy (`campaign_id`, `adset_id`, `ad_id`), channel, custom params | `kind`: click, impression, context |
| `link_domains`, `attribution_links` (extended) | Link host per app (go.leanapp.io or a custom domain), iOS/Android app config, routing rules per platform, deep link path, arbitrary deep-link data, custom params, channel, ad set / ad | Links are per environment |
| `deferred_link_contexts` | Context saved at click for recovery after install, claimed once | Short TTL; deterministic claim only, probabilistic only where allowed |
| `ad_networks`, `network_connections` | Supported networks; per-app connection (OAuth tokens encrypted), status, last verified | Nothing shows "connected" until a real call succeeded |
| `network_claims` | Install / re-engagement claims from self-attributing networks and Apple Search Ads | Reconciled with LeanApp's own match; both kept |
| `ad_spend_daily` | Cost per day × network × campaign × ad set × ad × country, currency | From network APIs, or manual / CSV entry in the MVP |
| `skan_schemas`, `skan_postbacks`, `skan_daily` | Conversion-value schema per app; raw verified postbacks; aggregates per network × campaign × day | Aggregate only, no user or install id, kept separate by design |
| `fx_rates_daily` | Daily currency rates | For ROAS and LTV in one reporting currency; per-currency figures stay available |

## 3. SDK changes (JS / React Native, Android, iOS, Flutter)

- `install_id`: generated on first launch, persisted, sent with every event; `app_installed` vs `app_opened`; reinstall detection where the platform allows (Android Play referrer install time, iOS keychain-backed id).
- First open: wait briefly for install context (Play referrer, Meta install referrer on Android, Apple Search Ads token on iOS) before sending `app_installed`.
- Deep links: `handleOpenUrl(url)` for Universal Links, App Links and custom schemes; `onDeepLink(handler)` with path, params, campaign and `isDeferred`; deferred lookup once on first open.
- Attribution state: `onAttribution(handler)` and `getAttribution()` returning source, campaign and match type when the server has decided.
- Identity: anonymous id → `identify(user_id)` already links; attribution follows the person.
- iOS: SKAN / AdAttributionKit conversion-value updates from the schema the server serves; Apple Search Ads token (`AAAttribution.attributionToken()`); IDFA only after App Tracking Transparency consent, and only if the app opts in.
- Android: Play Install Referrer (done); Meta Install Referrer (encrypted, decrypted server-side with the app's key from Meta); advertising id / App Set ID only with consent and only if the app opts in.
- Consent: no attribution identifiers and no SKAN updates while `attribution` consent is denied.

## 4. Platform integrations

| Integration | What it gives | Needs | Feasible without partner status |
| --- | --- | --- | --- |
| Apple Search Ads (AdServices API) | Deterministic campaign / ad group / keyword for installs from Search Ads | iOS 14.3+, the token from the SDK; no customer credentials | Yes |
| Apple SKAdNetwork / AdAttributionKit | Aggregate, delayed, privacy-thresholded installs and conversion values per network and campaign | Developer-copy postback endpoint in the app's Info.plist, verified signatures | Yes (developer copies) |
| Google Play Install Referrer | Deterministic click → install for LeanApp links and some Google traffic | Nothing extra | Yes (done) |
| Meta Install Referrer (Android) | Deterministic Meta campaign data for Android installs from Facebook / Instagram ads | The app's decryption key from the Meta App Dashboard | Yes |
| Meta, Google Ads, TikTok, Snapchat: cost and campaign APIs | Spend, impressions and clicks per campaign / ad set / ad for CPI and ROAS | Customer OAuth or tokens per network | Yes |
| Meta, Google Ads, TikTok, Snapchat: self-attributing-network install claims (user level) | The network's own claim that it drove an install, including view-through | Official MMP / attribution-partner certification with each network | **No: needs a partnership with each network** |
| Postbacks to networks (install and conversion events) | Lets networks optimise bidding | Customer tokens (built; custom URL verified) | Yes |
| Android Privacy Sandbox Attribution Reporting API | Future replacement for ad ids on Android | When Google enables it widely | Later |

## 5. MVP vs later

**MVP (build now):**

1. Data model: `installs`, the attribution record with first-touch and last-touch, `events.attribution_id`, per-user first / latest attribution.
2. Link service on `go.leanapp.io`: full metadata (source, medium, campaign, ad set, ad, creative, channel, custom params), click capture before routing, routing rules, Universal Links, App Links, custom schemes, web → app, QR codes, in-app-browser handling.
3. Deferred deep linking with context recovery: deterministic on Android (Play referrer); on iOS deterministic where a click id survives (App Clip, copied link with the user's consent) and otherwise labelled limited.
4. Matching with confidence, attribution windows, reattribution and re-engagement windows, organic vs paid, new vs returning.
5. Apple Search Ads and Meta Install Referrer integrations.
6. SKAN first class: schemas (fine and coarse values, revenue buckets, three windows), verified postbacks, campaign and network reporting, and a side-by-side view against deterministic numbers.
7. Cost: manual and CSV spend entry, so CPI, CAC and ROAS work from day one.
8. Dashboard: installs, paid / organic, CPI, CAC, campaign, source and country performance, post-install conversion, revenue and ROAS by source, LTV and retention by source, re-engagement, SKAN.
9. SDK support for all of the above in the four SDKs.

**Later:**

- Automatic cost import through Meta, Google Ads, TikTok and Snap APIs (OAuth per customer).
- Self-attributing-network claims and view-through, once LeanApp is a certified partner of each network.
- Impression (view-through) links where networks accept third-party impression trackers.
- Fraud detection (click flooding, install hijacking, device farms) beyond the current bot and rate filters.
- Multi-touch models beyond first / last touch.
- Android Privacy Sandbox attribution; AdAttributionKit re-engagement.

## 6. What cannot be replicated (Apple, Google and ad networks control the data)

- **iOS user-level attribution without consent.** Without App Tracking Transparency consent there is no IDFA, and Apple forbids fingerprinting. iOS paid installs from most networks can only be measured through SKAN / AdAttributionKit (aggregate) or a deterministic click id that survives the install (rare on iOS).
- **SKAN is aggregate by design.** Postbacks are delayed (24–48 h or more), subject to privacy thresholds that hide low-volume campaigns, and never identify a user or install. LeanApp keeps SKAN data separate and never joins it to users.
- **Network-side claims and view-through.** Meta, Google, TikTok and Snap only share user-level install claims (including view-through) with certified partners. Until LeanApp is certified, their installs are measured through LeanApp links, click ids, install referrers, SKAN and cost APIs. Numbers can differ from the networks' own dashboards, and the product says so.
- **Google App campaigns.** Detailed attribution is limited to Google's certified partners and Firebase; LeanApp sees what the Play referrer and click ids carry.
- **No 100% accuracy.** Every attribution carries a match type and confidence. Probabilistic matching stays off by default, is never used on iOS, and is reported separately.
