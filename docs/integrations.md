# Integrations Center

App → Settings → Integrations (`/o/{org}/apps/{app}/settings/integrations`) lists every provider LeanApp knows, by category, with the status of **each capability** in the selected environment. There is no project-wide "connected" flag.

Code: `apps/platform/src/modules/integrations/` (registry `registry.ts`, status rules `status.ts` and `center.ts`, tenant service `service.ts`, sync engine `sync.ts`, OAuth `oauth.ts`, ad adapters `ads/`). Migration `0035_integrations_center.sql`. Outbound conversion checks: `modules/attribution/conversions.ts` and `delivery.ts`.

## Concepts

| Concept | Where | Meaning |
| --- | --- | --- |
| Provider | `registry.ts` (code, not a table) | A company / API: Meta Ads, Google Ads, Resend, Stripe… |
| Data source | derived | A provider with at least one **inbound** capability (we read from it) |
| Service provider | derived | A provider with at least one **outbound** capability (we send to it) |
| Integration connection | `integration_connections` | One provider account linked to one environment (org/app/environment scoped), with encrypted credentials, non-secret settings, auth method (manual / OAuth), granted scopes and the list of missing fields |
| Provider capability | `integration_capabilities` (ad providers); other modules' own tables for the rest | One thing done with a provider, with its own config, enabled flag, status, last success, last error, freshness (`data_fresh_through`), schedule and backfill cursor |

Inbound and outbound stay separate: Meta **ad reporting import** (Marketing API, `integration_connections`) and Meta **Conversions API** (a postback, `attribution_postbacks`) are configured, credentialed and reported independently. Connecting one never turns on the other.

### Capability status

`not_configured` (nothing set up, or turned off) → `credentials_missing` (set up, a required credential or setting missing) → `unverified` (credentials stored, no successful call to the live provider yet) → `verified` (the last call to the provider succeeded) / `error` (the last call failed; the error is shown). Derived in `status.ts` (`deriveStatus`) and `center.ts` (`capabilityState`) from real records only:

| Capability | Status comes from |
| --- | --- |
| Ad reporting import, cost import (Meta, Google Ads, TikTok, Snapchat) | `integration_capabilities` (verify / sync outcomes) |
| Conversions API / postbacks | `attribution_postbacks` + last 30 days of `attribution_postback_deliveries` (last success, last failure, recent provider errors, skipped count) |
| Push, email, WhatsApp | `integrations` rows (`last_error`, `live_verified_at`) — owned by the messaging module |
| Webhooks | `webhooks` / `webhook_deliveries` |
| SKAdNetwork | `skan_postbacks` received |
| Tracking links, deep links | `attribution_links` + last click; `deep_link_configs.last_checked_at` |
| Event ingestion | SDK / API keys `last_used_at` |
| Plan payments (Stripe) | `paymentsConnected()` (server keys set → `unverified`; LeanApp does not call Stripe to render the page) |

Each part is read only when the viewer's role may read it (otherwise "No access"). Descriptor-only providers (LinkedIn Ads, Microsoft Advertising, X Ads, Pinterest Ads, GA4, HubSpot, App Store Server Notifications, Google Play RTDN) have no capabilities and no setup action: the card links to the provider's official API docs and offers "Ask for it" (email).

Categories: Advertising Platforms · Analytics and Event Sources · Attribution and Deep Links · Messaging Providers · CRM and Customer Data · Commerce and Revenue Sources · Webhooks and Custom Integrations · Billing and Payments.

## Ad reporting import (inbound)

Per provider page (`settings/integrations/{meta_ads|google_ads|tiktok_ads|snapchat_ads}`): credentials and settings, **Test connection** (token refresh + list ad accounts against the live API), **Import now**, **Remove connection**, capability toggles, **Import history** (backfill) and the last import runs and imported campaigns.

Shared adapter interface (`ads/types.ts`): `prepare` (token refresh hook; rotated secrets are re-encrypted and stored), `listAccounts` (verification), `report` (one page of daily rows: day, account, campaign / ad set / ad ids and names, currency, impressions, clicks, spend, conversions). HTTP (`ads/http.ts`): 20 s timeout (8 s in the worker), up to 4 attempts with exponential backoff honouring `Retry-After` for rate limits and transient errors, a per-run request budget (400) and deadline, provider-specific error classification (auth / rate_limited / transient / permanent / config), and paging URLs from responses only followed on the provider's own host. Errors never contain URLs or headers.

| Provider | Endpoints used | Credentials (manual) | Notes |
| --- | --- | --- | --- |
| Meta | `GET graph.facebook.com/{v23.0}/me/adaccounts`, `GET …/act_{id}/insights?level=ad&time_increment=1` (paging.next) | Access token with `ads_read` (system user) | Throttling codes 4/17/32/613/80000–80014 retried; code 190 = reconnect. Conversions = sum of the action types you list (optional). |
| Google Ads | `POST oauth2.googleapis.com/token` (refresh), `GET googleads.googleapis.com/{v}/customers:listAccessibleCustomers`, `POST …/customers/{id}/googleAds:search` (GAQL on `ad_group_ad`, `nextPageToken`) | Developer token, OAuth client id/secret, refresh token; API version **required** (not assumed) | `login-customer-id` for manager accounts; cost from `cost_micros`. |
| TikTok | `GET business-api.tiktok.com/open_api/v1.3/advertiser/info/`, `GET …/report/integrated/get/` (BASIC, AUCTION_AD, `ad_id` × `stat_time_day`, page / page_size 1000) | Long-lived Marketing API access token | HTTP 200 with non-zero `code` is an error; 40100 retried. |
| Snapchat | `POST accounts.snapchat.com/login/oauth2/access_token` (refresh), `GET adsapi.snapchat.com/v1/adaccounts/{id}`, `/campaigns`, `/stats?granularity=DAY&breakdown=campaign` | OAuth client id/secret, refresh token | Campaign level only; swipes counted as clicks; spend in micro-currency; days in the ad account's timezone. |

**Sync engine** (`sync.ts`, scheduled worker step `ad_sync` in `/api/internal/process-events`, and "Import now"): claims due capabilities with `FOR UPDATE SKIP LOCKED` (15-min lease), plans the range (`planSync`: first run = last 30 days; then the last imported day minus 3 restatement days → today; after a pause it catches up 30 days at a time, oldest first; backfill walks back in 30-day chunks to the requested day, at most 395 days), replaces `ad_performance_daily` for the range, upserts `ad_entities` (accounts, campaigns, ad sets, ads with external ids), records an `integration_sync_runs` row, and updates status, freshness and the next run (6 h; immediately while a backfill or catch-up continues; 15 min → 1 h → 6 h → 24 h after failures; auth / config errors stop scheduling until credentials change).

**Cost import** is its own capability (needs ad reporting on). It writes the daily cost per campaign (campaign name, else id) into the existing `ad_spend_daily` table with `origin = 'import'` and the connection id, under a source name you choose (default `meta`, `google`, `tiktok`, `snapchat`; use the same name your tracking links use so CAC / ROAS line up). An import never overwrites a hand-entered row for the same day / source / campaign / currency (counted as "kept" on the run); entering a day by hand replaces an imported row. Turning cost import off, or removing the connection, deletes only imported rows. Report caches are purged after each write. Revenue by channel, CAC & LTV and any CPA built on `ad_spend_daily` use imported spend automatically.

## OAuth ("Connect with …")

Shown only when the operator configured LeanApp's own provider app (env below); otherwise customers paste credentials. Start: a server action stores the SHA-256 of a 32-byte random state bound to the user, organization and environment (10-minute expiry, `integration_oauth_states`) and sets it as an httpOnly SameSite=Lax cookie scoped to `/integrations/oauth`. Callback `GET /integrations/oauth/{provider}/callback`: requires the signed-in user, a state equal to the cookie, unused, unexpired, same user and provider (consumed even when rejected); exchanges the code server-side (Meta: short- then long-lived token; Google: refresh token with `access_type=offline`; TikTok: `auth_code` → access token + advertiser ids; Snap: refresh token), stores it encrypted and returns to the provider page. Connections made this way stay `unverified` until a real call succeeds.

## Outbound conversions (Meta CAPI, Snap CAPI and other postbacks)

Built on the existing postbacks ([attribution](attribution.md#postbacks)). Added in `conversions.ts` / `delivery.ts`, checked right before each send:

- **Consent**: the user's or install's latest `attribution` consent (`consent_state`) is read at send time; denied → `skipped` (`consent_denied`), never sent.
- **Eligibility**: Meta needs an `fbclid` or the install id (sent as `user_data.anon_id`); Snap needs a `ScCid`. Otherwise `skipped` (`no_match_key`).
- **Payload validation** (Meta, Snap, TikTok): event name, `event_id` (deduplication key), integer Unix `event_time` not in the future and at most 7 days old, value ≥ 0 with a 3-letter currency, Meta app events need `app_data` and a non-empty `user_data`. Failing → `skipped` (`invalid_payload`) with the reason.
- **Deduplication**: one delivery per postback and attribution / conversion (unique idempotency key), and every request carries that stable `event_id` (Google: `orderId`).
- **Retries**: as before (1 min → 12 h), plus provider "try later" codes sent with HTTP 400 (Meta 1/2/4/17/32/613, TikTok 40100, Google RESOURCE_EXHAUSTED/UNAVAILABLE).
- **Delivery log**: `skip_reason`, `provider_error_code` (e.g. Meta `100/2804050`), `provider_trace_id` (Meta `fbtrace_id`, Snap / TikTok `request_id`) and `request_summary` (endpoint without query string, event names and ids; never tokens), shown on the Postbacks page and summarised on the center card.

## Simulated vs live

Everything above is tested with local fakes (`src/modules/integrations/**/*.test.ts`, `src/modules/attribution/conversions.test.ts`, `test/integrations.int.test.ts`): request shapes, paging, parsing, retries, error classification, status transitions, spend import, OAuth state handling, consent skipping. **None of it has been run against Meta, Google, TikTok or Snap**: no account or app exists yet. Endpoint paths follow each provider's published documentation; the Meta Graph default version (`v23.0`) and the Google Ads version you enter must be checked against the providers' current release notes. A capability turns `verified` only after a real call succeeds in production.

## Owner actions

1. Keep `INTEGRATIONS_ENCRYPTION_KEY` set (already required for postbacks and messaging).
2. Optional, for "Connect with …" (each needs a provider app review before other businesses can use it):
   - **Meta**: create a Meta app (Business type) with Marketing API, request `ads_read` advanced access (App Review), add redirect URI `https://app.leanapp.io/integrations/oauth/meta_ads/callback`; set `META_APP_ID`, `META_APP_SECRET`.
   - **Google Ads**: Google Cloud OAuth client (web) with redirect URI `…/integrations/oauth/google_ads/callback`, OAuth consent screen verification for the `adwords` scope, and a Google Ads API developer token with Basic or Standard access; set `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_DEVELOPER_TOKEN`, optionally `GOOGLE_ADS_API_VERSION` (a version Google lists as supported).
   - **TikTok**: TikTok for Business developer app with Reporting scope, redirect URI `…/integrations/oauth/tiktok_ads/callback`; set `TIKTOK_APP_ID`, `TIKTOK_APP_SECRET`.
   - **Snapchat**: Snap Business Manager OAuth app (Marketing API), redirect URI `…/integrations/oauth/snapchat_ads/callback`; set `SNAPCHAT_CLIENT_ID`, `SNAPCHAT_CLIENT_SECRET`.
3. Live verification, per provider, with a real ad account: connect, **Test connection**, turn on ad reporting, **Import now**, compare a day's spend with the provider's UI, then turn on cost import. For Meta / Snap CAPI, send a test install from a link with `fbclid` / `ScCid` and check the network's events manager.
4. Then update the "not verified" notes here and in [attribution](attribution.md).

## Hooks for other workstreams

- **Messaging providers**: `messagingDescriptors()` in `registry.ts` is the hook; replace its body with a mapping from the messaging provider registry when it lands. Status already reads any provider row in `platform.integrations`.
- **Channel registry / CPA**: imported cost lands in `ad_spend_daily` (`origin = 'import'`), so anything reading that table includes it.
- **Billing**: the Stripe card reads `paymentsConnected()`; a richer billing status can be plugged into `centerData`.
