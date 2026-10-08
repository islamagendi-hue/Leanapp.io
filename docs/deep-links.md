# Deep links

Two places, two audiences:

- **Acquisition → Deep links** (`/acquisition/deep-links`, `attribution.read`): the business view. What works today in the selected environment, the links that carry a deep link with their clicks, installs, re-engagements and deferred matches, and a channel-preset form to create one. A link's share URL and QR code are on Tracking links & QR (`/acquisition/links?link={code}`); the old `/acquisition/deep-links?link=…` address forwards there.
- **Settings → Dev Ops → Deep link setup** (`/settings/dev-ops/deep-links`, `deep_links.read` / `deep_links.manage`): the technical setup per environment: link prefix or custom domain, iOS Team ID and bundle ids, Android package and signing certificates, URI scheme, the in-app browser page, the deferred API switch, and the apple-app-site-association / assetlinks.json check.

## What works today

The business page computes this from the environment's setup (`modules/deeplinks/capabilities.ts`, pure, unit tested):

| Capability | Status |
|---|---|
| Store and web fallback | Live for every link |
| Open the installed app on iOS (Universal Links) | Live once configured **and** the last check of apple-app-site-association passed; "Not verified" when configured but unchecked or failing; "Needs setup" otherwise |
| Open the installed app on Android (App Links) | Same, with assetlinks.json |
| Campaign data on app opens | Live: the Android SDK reads the opened link itself; on iOS and Flutter the app passes the URL to `captureAttribution()`. Later events carry the link's campaign and the open counts as a re-engagement |
| Deep link after install (deferred) | **Beta, API only**, or Off / Needs setup. The server answers `POST /v1/deep-links/deferred`, but no LeanApp SDK calls it yet |

Landing on the link's screen when the installed app opens is up to the app: it sends the opened URL to `GET /v1/deep-links/resolve` and routes to the returned `deep_link`. The SDKs don't wrap this yet either. Nothing in the product claims deferred deep linking works end to end.

## Report

`modules/deeplinks/report.ts` `deepLinkReport(ctx, environmentId, days)` (7 / 30 / 90): per link with a deep link (top 50 by clicks) clicks, installs and re-engagements from the attribution tables, and deferred matches from `deep_link_deferred_matches`; plus the environment's deferred lookups by match (exact, probabilistic, none). Tenant-scoped under `attribution.read`; RLS keeps other organizations out.
