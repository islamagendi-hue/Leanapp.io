# Deep links

Two places, two audiences:

- **Acquisition → Deep links** (`/acquisition/deep-links`, `attribution.read`): the business view. What works today in the selected environment, the links that carry a deep link with their clicks, installs, re-engagements and deferred matches, and a channel-preset form to create one. The presets come from the [channel registry](channels.md) (owned, referral and offline, organic and paid channels, each with its source / medium); old preset ids still work. A link's share URL and QR code are on Tracking links & QR (`/acquisition/links?link={code}`); the old `/acquisition/deep-links?link=…` address forwards there.
- **Settings → Dev Ops → Deep link setup** (`/settings/dev-ops/deep-links`, `deep_links.read` / `deep_links.manage`): the technical setup per environment: link prefix or custom domain, iOS Team ID and bundle ids, Android package and signing certificates, URI scheme, the in-app browser page, the deferred API switch, and the apple-app-site-association / assetlinks.json check.

## What works today

The business page computes this from the environment's setup (`modules/deeplinks/capabilities.ts`, pure, unit tested):

| Capability | Status |
|---|---|
| Store and web fallback | Live for every link |
| Open the installed app on iOS (Universal Links) | Live once configured **and** the last check of apple-app-site-association passed; "Not verified" when configured but unchecked or failing; "Needs setup" otherwise |
| Open the installed app on Android (App Links) | Same, with assetlinks.json |
| Campaign data on app opens | Live: the Android SDK reads the opened link itself; on iOS and Flutter the app passes the URL to `captureAttribution()`. Later events carry the link's campaign and the open counts as a re-engagement |
| Deep link after install (deferred) | **Beta**, or Off / Needs setup. The server answers `POST /v1/deep-links/deferred`; the Android, iOS, Flutter and React Native SDKs call it once on the first launch of a new install (after attribution consent) and hand the answer to the app's `onDeferredDeepLink` callback. The SDK side is unit tested with mocked HTTP only (iOS and Flutter not yet compiled); not verified on a device yet |

Landing on the link's screen is up to the app in both cases: for a deferred match it routes to `deep_link.path` / `params` from the callback; when the installed app opens from a link it sends the opened URL to `GET /v1/deep-links/resolve` and routes to the returned `deep_link` (the SDKs don't wrap `resolve` yet). Nothing in the product claims deferred deep linking works end to end until it has been checked on real devices.

**What the SDKs send** (see [SDKs](sdk.md#deferred-deep-links)): `anonymous_id`, `platform`, `os`, `os_version`; on Android also the Play `install_referrer` and the LeanApp `click_id` found in it; any SDK sends a LeanApp `click_id` it already captured from an opened URL. Installs from before the SDK version that added the call never ask. A 2xx, 400 or 422 answer is final for the install; network errors, 429 and 5xx are asked again on the next launch.

**Deferred matching** (`modules/deeplinks/service.ts` `deferredDeepLink`), once per install (`anonymous_id`): exact when the Play install referrer (or the app) passes a LeanApp click id recorded within the app's click lookback; otherwise, only if probabilistic matching is on in attribution settings and only on Android, the latest *unclaimed* click from the same keyed IP hash and Android major version within both the probabilistic window and the click lookback. The click it hands out is claimed (`attribution_touchpoints.matched_at`, row-locked while claiming): the install engine then uses that click for this install (unless the install carries its own LeanApp click id, or for a probabilistic hand-off, campaign parameters) and never gives the click to another install probabilistically, and a click the engine already attributed to another install is never handed out probabilistically here. See [attribution](attribution.md#matching-installs).

## Report

`modules/deeplinks/report.ts` `deepLinkReport(ctx, environmentId, days)` (7 / 30 / 90): per link with a deep link (top 50 by clicks) clicks, installs and re-engagements from the attribution tables, and deferred matches from `deep_link_deferred_matches`; plus the environment's deferred lookups by match (exact, probabilistic, none). Tenant-scoped under `attribution.read`; RLS keeps other organizations out.

## iOS and privacy limits

What links can and can't tell about an install, stated the same way in the product:

- **Universal Links / App Links open an installed app**; they do not survive an install. After a store install, the only deterministic link back to the click is a LeanApp click id: on Android the Play install referrer carries it; on iOS only if the app passes one on (e.g. a link opened after install, or the app reading a click id the user copied with consent). LeanApp never fingerprints iOS devices, and probabilistic matching is Android-only and off by default.
- **UTM parameters don't make an install deterministic.** They are what the opened URL or referrer says; installs matched only on them are labelled *observed* (`reported`), never deterministic.
- **Paid iOS installs** without a click id are *unattributed*; SKAdNetwork / AdAttributionKit postbacks are aggregate and provider-reported, shown separately and never joined to users. The iOS SDK sends Apple's AdServices token once, on `app_installed` (`context.attribution.adservices_token`); reading it against Apple's attribution API is the server's Apple Search Ads integration, not the SDK's.
- **Social in-app browsers** (Instagram, Facebook, TikTok, Snapchat, …) don't hand Universal Links to iOS; the interstitial page offers the custom scheme (iOS asks first) and the store.
- **Deferred deep links** stay Beta: exact on Android via the install referrer; on iOS only when the SDK or the app has a LeanApp click id (otherwise the answer is `match_type: "none"`).
