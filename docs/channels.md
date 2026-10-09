# Growth channels

One channel registry for every place a person can come from or be reached, used by attribution, the Acquisition reports, tracking-link presets and ad spend. Code: `apps/platform/src/modules/channels/` (registry `registry.ts`, parameter normalisation `normalize.ts`, classification and evidence `classify.ts`, reconciliation `reconcile.ts`, report arithmetic `report-pure.ts`, report queries `report.ts`, custom channels and rules `service.ts`). Migration `0034_growth_channels.sql`.

**Status: built and tested against Postgres with simulated events; no external API is called.** Nothing here connects to an ad platform, messaging provider or store: those connections, their credentials and their capability status live in the integrations center (ad platforms, cost import) and in [messaging](messaging.md) (owned channels). A channel being listed here says nothing about whether a provider is connected.

## Concepts kept apart

| Concept | What it is | Where it lives |
| --- | --- | --- |
| Channel | Where a person came from or was reached: `meta_ads`, `organic_search`, `whatsapp`, `qr`, `custom_radio` | This registry |
| Data source | What told LeanApp: a tracking-link click, the install's own context (install referrer, deep link, UTMs), a provider report (SKAdNetwork postback) | Attribution engine, touchpoints |
| Evidence | How sure the credit is: deterministic, observed, provider-reported, modeled, none | `classify.ts` `evidenceOf` |
| Provider / connection / capability | The company behind a channel and what LeanApp can do with it, with per-capability status | Integrations (ad platforms), messaging (owned channels) |

## The registry

Built-in channels are code, never stored (`BUILT_IN_CHANNELS`); each has a stable key, a group, aliases for sources, mediums and referrer hosts, the attribution network key for paid channels, and a tracking-link preset where one makes sense.

| Group | Channels |
| --- | --- |
| Paid | Meta (Facebook, Instagram) `meta_ads`, Google Ads incl. app campaigns `google_ads`, TikTok `tiktok_ads`, Snapchat `snapchat_ads`, Apple Search Ads `apple_search_ads`, LinkedIn `linkedin_ads`, Pinterest `pinterest_ads`, X `x_ads`, Microsoft `microsoft_ads`; other ad platforms as custom channels |
| Organic | Organic search, organic social, content and SEO, App Store and Google Play discovery `app_store`, referral sites |
| Owned and lifecycle | WhatsApp, email, SMS, mobile push `push`, web push, in-app messages `in_app`, website / forms / landing pages `website` (keys match the messaging channel ids `whatsapp`, `email`, `sms`, `push`, `web_push`, `in_app`) |
| Referral, partners and offline | Referral program and invites, affiliates, influencers and creators, partners, QR codes, physical stores and POS, events, call center, manual sources |
| No source | `direct`, `unknown`, `unattributed` (three separate channels) |
| Custom | Customer-defined channels per app (`custom_…`), in any of the groups above |

**Direct, unknown and unattributed are never organic** and never merged:

- `direct`: the parameters said so (`utm_source=(direct)`, `direct` with no medium or medium `(none)`).
- `unknown`: there was a source, but no rule recognises it (including `utm_medium=organic` from a source that isn't a store, search engine or social network).
- `unattributed`: nothing was observed or matched (no click id, no campaign parameters, no referrer). Paid iOS installs without a click id land here.

Organic is only claimed when the data says it: the store's own organic referrer (Google Play `utm_source=google-play&utm_medium=organic` → `app_store`), a search-engine or social referrer, or `utm_medium=organic` from a known search or social source.

## Normalising touch parameters

`normalizeTouch(params)` takes any flat parameter map (link URL query, `context.attribution`, `context.campaign`, an install referrer, a stored touchpoint) and returns: `source` and `medium` (lower case, spaces → `_`), `campaign`, `campaignId` (`utm_id`, `campaign_id`), `content` (`utm_content`, `creative`), `term` (`utm_term`, `ad_group`, `keyword`), `clickIds` (gclid, gbraid, wbraid, dclid, fbclid, ttclid, ScCid, twclid, msclkid, li_fat_id, epik), `referralId` (`referral_code`, `invite_code`, `referrer_id`, `ref`), `referrerHost`, `custom` dimensions (other `utm_*` keys, `cd_*`, `custom_*`) and `raw` (every parameter as received). Raw parameters stay in `attribution_touchpoints.raw` / `referrer` / `landing_page` as before, so a changed rule can be re-applied.

The click-id table in the registry (`CLICK_ID_CHANNELS`, `CLICK_ID_NETWORKS`) replaces the separate lists the attribution engine, the click redirect and the deep-link reserved parameters used to keep; `dclid` and `epik` are now recorded too.

## Classification

`classifyTouch` (first match wins): the app's custom rules by priority → an ad-network click id → explicit direct → a paid medium (`cpc`, `paid_social`, `display`, `app`, …) gives the source's paid channel (else `unknown`) → `utm_medium=organic` → a medium that names a channel (email, sms, push, influencer, qr, referral, …) → a source that names a channel (a paid network's source with a non-paid medium counts as its organic counterpart: `instagram / social` → organic social) → the referring host → `unknown`; nothing at all → `unattributed`. A paid network's source with no medium (`utm_source=tiktok`) counts as that paid channel, as postback routing always has.

Classification runs at report time over the denormalised `source`, `medium`, `network`, `match_type` and `match_key` of each attribution, so changing a rule re-labels history without rewriting stored data. Spend sources are classified the same way.

## Custom channels and rules (per app)

Settings → Dev Ops → Attribution → Channels and rules (`attribution.read` sees them, `attribution.manage` changes them; every change is audited as `channels.*` and drops the app's cached report results).

- `platform.channel_definitions`: `key` (`custom_` + snake case, unique per app), `label`, `channel_group`, `description`, `status` (active / archived).
- `platform.channel_rules`: `channel_key` (built-in or custom; not `unattributed`), `priority` (1–1000, lower first), `conditions` (every one given must hold: `source` list, `medium` list, `campaignPrefix`, `referrerHost` (suffix match), `clickIdParam`, `hasReferralId`), `note`, `status` (active / paused). Empty conditions are refused; rules pointing at an archived channel are skipped.

Both tables are tenant-scoped with the standard RLS policy.

## Evidence (what each number rests on)

| Evidence | Meaning | From |
| --- | --- | --- |
| Deterministic match | A click id came back and matches a click LeanApp's own link recorded | `match_type = deterministic` |
| Observed | LeanApp saw campaign parameters, an ad-network click id or a store referrer on the install / open / visit, but no recorded click verifies them | `reported`, and organic installs with `match_key` `store_organic` or `direct` |
| Provider-reported | A provider says so in aggregate: SKAdNetwork / AdAttributionKit postbacks today; ad-platform reports once the integrations center imports them | `skan_postbacks`; shown next to LeanApp's counts, never added |
| Modeled | Inferred: the opt-in Android IP-hash + OS match | `probabilistic` |
| None | Nothing observed or matched | `organic` with no match key |

UTM parameters never make a mobile install deterministic. They are what the install says about itself.

## Attribution models and windows

- **Last touch** (as before): each conversion is credited to the person's latest install, reinstall or re-engagement before it within the conversion window (`attribution_conversions.attribution_event_id`).
- **First touch** (new): the person's earliest install, reinstall or re-engagement within the same window (`attribution_conversions.first_attribution_event_id`, written by event processing from migration 0034 on, `first_touch_recorded = true`). Conversions processed before 0034 have no first-touch record; the first-touch view uses their last touch and says how many (rule C3).
- Windows per app (Settings → Dev Ops → Attribution): click lookback (1–90 days), conversion window (1–730 days, also the first-touch window), probabilistic window (1–168 hours), re-engagement on/off, and **Reports open with** (`attribution_settings.reporting_model`, last or first touch). Both models are always selectable on Sources & campaigns.

The engine now stores why a no-match install is organic: `match_key = store_organic` (the store's own organic referrer), `direct` (direct / none parameters) or `organic_other` (organic from an unrecognised source → `unknown`); `null` is unattributed. Shared channel labels in Analytics (Revenue, Funnels, Events, Churn, CAC & LTV) follow suit: `organic` only for `store_organic`, `(direct)`, `(unattributed)`, `(unknown)`, `(no install on record)` (`analytics/sql.ts` `channelLabelSql`). Installs processed before this change have no match key and show as unattributed: that is accurate, since nothing said they were organic.

## Channel analytics

Acquisition → **Sources & campaigns** opens with a **Channels** table (model selector next to the range), and Acquisition → **Overview** shows the top channels; both show **Coverage and freshness**. No new page: the numbers sit with the existing Acquisition reports. Per channel, for the range (app timezone, per environment):

| Number | Source | When it's not available |
| --- | --- | --- |
| Clicks | Tracking-link clicks (bots and prefetches excluded) | — |
| Installs (+ evidence line) | `attribution_events` install / reinstall | — |
| New users | People whose first install on record is in the range (stitched as in Analytics) | — |
| Activated, D7 retention (D1 / D30 in the data) | `growth_state` of those new users; retention counts only people who have had N days | "—" with a note when the app's growth model is off |
| Sign-ups | Conversions named `sign_up`, `signup_completed`, `registration(_completed)`, `account_created`, … | Only when those events are conversion events in the plan |
| Purchases, revenue | Conversions with positive revenue; revenue per currency, refunds negative, never converted | — |
| Spend, CPI, CPA | `ad_spend_daily` reconciled (below); CPI = spend ÷ installs, CPA = spend ÷ purchases, per spend currency | Needs `analytics.read`; "—" without spend |
| Coverage | Installs with a touch vs unattributed (with the iOS count), conversions with an install on record, provider-reported postbacks (not added) | — |
| Freshness | Last click, last matched install / open, last processed attribution, last conversion, last spend day and save | — |

**Not reported:** sessions by channel (no LeanApp SDK sends a session event carrying the touch); installs or first opens that LeanApp never received (e.g. ad-network-reported installs without a click). The page says so.

## Reconciliation rules

Implemented in `reconcile.ts` and `report-pure.ts`, unit-tested:

- **S1** A day's spend for a source and currency entered both for the whole source (campaign '') and per campaign: the campaign rows count, the whole-source row is left out and listed with its amount.
- **S2** Two spellings of one channel (`facebook` / `meta`, `snapchat` / `snap`) with the same day, campaign, currency and amount: counted once and listed. Different amounts both count (Facebook and Instagram spend are both Meta).
- **S3** Amounts are never converted or added across currencies.
- **S4** Spend on a source no rule recognises stays on `unknown`, never spread over other channels. Spend can't be entered on organic, direct, unknown or unattributed (`NON_SPEND_SOURCES`).
- **C1** One conversion per processed event (`attribution_conversions` unique per event row; ingestion drops repeated event ids).
- **C2** Each conversion is on exactly one channel per model; first- and last-touch totals are two views of the same conversions, never added.
- **C3** Pre-0034 conversions use their last touch in the first-touch view, counted on the page.
- **R1** Revenue per currency, refunds negative.
- **R2** Provider-reported numbers are shown next to LeanApp's own, never added.

## Tracking-link presets

The Deep links "New deep link" form lists every registry channel with a link preset, grouped (owned, referral, organic, paid), instead of the old hard-coded list; old preset ids (`paid`, `web_banner`, `social_organic`) still resolve (`LEGACY_PRESET_IDS`).

## Tests

- Unit: `channels/classify.test.ts` (registry coverage, normalisation, classification order, custom rules, evidence), `reconcile.test.ts`, `report-pure.test.ts`, `attribution/pure.test.ts` (`organicReason`).
- Integration (Postgres, simulated SDK events and link clicks): `test/growth-channels.int.test.ts` — organic / direct / unattributed reasons, first vs last touch, the channel report with evidence, coverage and spend reconciliation, the reporting model setting, custom channels and rules (validation, audit, pause / archive / delete), RBAC and tenant isolation.

## Owner actions

None required to use it. Optional: turn on the growth model (Growth settings) so activation and retention by acquisition channel are measured; add custom channels and rules for sources the registry doesn't know (`unknown` in the Channels table shows which).
