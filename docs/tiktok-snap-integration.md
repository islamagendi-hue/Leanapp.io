# TikTok and Snap integration

What LeanApp does with TikTok and Snap, what each part needs, and the steps only the product owner (or each customer) can take on their side. **No TikTok or Snap app review, approval or partner status has been requested or granted for LeanApp, and none of this has been verified against TikTok's or Snap's live APIs.** All tests use local fakes (see [integrations.md](integrations.md#simulated-vs-live)).

LeanApp's own analytics and attribution never depend on TikTok or Snap. The LeanApp SDKs collect product events without either company's SDK or pixel.

## Capabilities

Each capability is set up, permissioned and reported on its own in Settings → Integrations. Connecting one does not turn on another, and does not grant permissions for it.

| Capability | Direction | Provider API | Where it is set up | Credential |
| --- | --- | --- | --- | --- |
| Ad reporting and cost import | inbound | TikTok Marketing API reporting / Snap Ads API stats | Settings → Integrations → TikTok Ads / Snapchat Ads | see [integrations.md](integrations.md#ad-reporting-import-inbound) |
| App events | outbound | TikTok Events API 2.0 `event_source: "app"`; Snap Conversions API v3 `action_source: "MOBILE_APP"` | Postbacks → TikTok / Snap, Event source "App events" | Events API access token / Conversions API token (the customer's) |
| Website events | outbound | TikTok Events API 2.0 `event_source: "web"`; Snap Conversions API v3 `action_source: "WEB"`, sent alongside the customer's browser pixel | Postbacks → TikTok / Snap, Event source "Website events" (or "By platform") | the same token, issued for the pixel |

Code: `apps/platform/src/modules/attribution/networks.ts` (request builders, settings), `conversions.ts` (eligibility, validation, hashing, request summary), `delivery.ts` (send-time context, consent, retries, log); capability registry `modules/integrations/registry.ts` and `connectors.ts`; web SDK `sdks/javascript/src/attribution.ts` (`pixelBrowserIds`). No migration: the settings live in the existing `attribution_postbacks.config`.

## Postback settings

| Setting (`config.*`) | TikTok | Snap |
| --- | --- | --- |
| App id (app events) | `tiktok_app_id` | `snap_app_id` |
| Pixel id (website events) | `tiktok_pixel_code` | `snap_pixel_id` |
| Event source `action_source` | `app` (default), `website`, `auto` (events from the web SDK as website, the rest as app) | same |
| Hashed user data `send_user_data` | `off` (default), `with_consent`, `unless_denied`; website events only | same |
| Test event code `test_event_code` | optional, sent as `test_event_code` | not offered |

Saving a postback checks the ids against the event source. `app` needs the app id, `website` needs the pixel id, and `auto` needs both. Postbacks created before this change have no `action_source`, so they keep sending app events exactly as before.

## What LeanApp sends

Only events the LeanApp attribution engine attributed and queued for the postback, by network or by listed sources. The connector does not decide which ad gets credit.

### TikTok Events API 2.0, website events

`POST https://business-api.tiktok.com/open_api/v1.3/event/track/` with header `Access-Token`:

```json
{
  "event_source": "web",
  "event_source_id": "<tiktok_pixel_code>",
  "test_event_code": "<only when set>",
  "data": [{
    "event": "CompletePayment",
    "event_time": 1790000000,
    "event_id": "<the LeanApp event's own event_id>",
    "user": { "ttclid": "…", "ttp": "<_ttp cookie>", "email": "<sha256>", "phone": "<sha256>", "external_id": "<sha256>", "user_agent": "…" },
    "page": { "url": "https://shop.example/thanks" },
    "properties": { "value": 200, "currency": "AED" }
  }]
}
```

- Event names: a purchase with revenue is `CompletePayment`, a sign-up / registration is `CompleteRegistration`, and an event ending in `_viewed` or named `view_content` is `ViewContent`. Other events keep their LeanApp name. `config.event_map` overrides any of them.
- TikTok's older pixel-track endpoint nests these fields under `context` (`context.page.url`, `context.user_agent`). Events API 2.0 (`/event/track/` with `event_source` / `event_source_id` / `data[]`, the endpoint LeanApp already used for app events) takes `page.url` and `user.user_agent` per event, so LeanApp sends those. Check this against TikTok's current documentation during live verification.
- Hashing: email is trimmed and lowercased; phone is E.164 with the `+` (numbers without a country code are dropped, never guessed); the user id is used as is. Each is sent as one SHA-256 hex string.

### Snap Conversions API v3, website events

`POST https://tr.snapchat.com/v3/{snap_pixel_id}/events?access_token=…`:

```json
{
  "data": [{
    "event_name": "PURCHASE",
    "event_time": 1790000000,
    "event_id": "<the LeanApp event's own event_id>",
    "action_source": "WEB",
    "event_source_url": "https://shop.example/paid",
    "user_data": { "client_user_agent": "…", "sc_click_id": "…", "sc_cookie1": "<_scid cookie>", "em": ["<sha256>"], "ph": ["<sha256>"], "external_id": ["<sha256>"] },
    "custom_data": { "value": 90, "currency": "SAR" }
  }]
}
```

- Event names: `PURCHASE`, `SIGN_UP`, `VIEW_CONTENT` (same rules as TikTok), overridable with `config.event_map`.
- Hashing: email trimmed and lowercased; phone as digits with the country code; the user id as is; each one an array of SHA-256 hex strings.
- App events now carry `action_source: "MOBILE_APP"`. Before this change they carried `"app"`, which is not one of the values Snap's v3 documentation lists (`WEB`, `MOBILE_APP`, `OFFLINE`). Check this against Snap's current documentation during live verification.

### Where the web fields come from

Everything is read at send time from the stored event behind the delivery (`delivery.ts` `loadSendContext`). Nothing is copied onto the delivery row.

| Field | Source |
| --- | --- |
| event id | the LeanApp event's own `event_id`: if the site also runs the TikTok or Snap browser pixel, send the same value as the pixel's event id (TikTok `event_id`, Snap `client_dedup_id`) so the network counts the pair once |
| page URL | event `properties.url`, `properties.page_url`, `context.page.url`, else `context.attribution.landing_url` (fragment dropped) |
| user agent | `context.user_agent` (the web SDK adds it to every event) |
| `ttp` / `sc_cookie1` | `context.attribution.ttp` / `scid` of the event, else the visitor's latest earlier event within 90 days. Values that don't look like an opaque cookie id (spaces, quotes, under 8 or over 200 characters) are dropped |
| click id | `ttclid` / `ScCid` of the attribution |
| hashed user data | the `email` / `phone` user properties and the user id, only when `send_user_data` and the user's `attribution` consent allow it |

`client_ip_address` / `ip` is not sent, because LeanApp does not store visitors' IP addresses.

### Checks before sending

- **Consent**: users or installs that denied `attribution` consent are `skipped` (`consent_denied`) and never sent. This is checked again at send time.
- **Match key**: a website event needs a click id (`ttclid` / `ScCid`), the pixel cookie (`_ttp` / `_scid`) or allowed hashed user data. Otherwise it is `skipped` (`no_match_key`). App events are unchanged: Snap needs a `ScCid`, and TikTok app events are sent as before.
- **Validation** (`skipped`, `invalid_payload`, with the reason): event name, `event_id`, integer `event_time` within the last 7 days, value ≥ 0 with a 3-letter currency. Website events also need the page URL, the user agent and a match key. They can't be installs or app opens, and hashed fields must be SHA-256 hex.
- **Delivery log**: endpoint without query string (the Snap token is in the query), event names and ids, `action_source` (`web` / `WEB`), the *names* of the match keys sent, and `test_event` when a TikTok test code was set. It never holds tokens, cookie values, hashes, user agents or contact data. TikTok `request_id` and Snap `request_id` are kept as the trace id.

**Sending a conversion does not mean TikTok or Snap will attribute it to an ad.** Each network applies its own matching, attribution windows and privacy rules. LeanApp's dashboards keep LeanApp's observed attribution separate from anything the networks report.

## Web SDK

With `marketing` consent granted, the JavaScript SDK reads TikTok's `_ttp` and Snap's `_scid` first-party cookies into `context.attribution.ttp` / `scid` on every event, the same way it reads Meta's `_fbp` / `_fbc`. It only reads these cookies: it never sets them, never builds a value when one is missing, and never loads either pixel. `tiktokBrowserId: false` / `snapBrowserId: false` turn the reading off. Without marketing consent neither value is sent; without `attribution` consent the platform drops `context.attribution` anyway.

## Owner actions on TikTok's and Snap's side

None of these can be done in code. Status today: **not started** for all.

### TikTok (per customer)

1. In TikTok Ads Manager → Tools → **Events Manager**, create a **web pixel** for the site (Connect data source → Web). Note the **pixel code** and enter it as "TikTok Pixel code" on the postback. For app events, register the app and note the **TikTok App ID**.
2. On the pixel's Settings page, generate an **Events API access token** (Events Manager → the pixel → Settings → Events API → Generate access token). Enter it as the postback's "Events API access token". It is encrypted at rest and never shown again.
3. If the site also runs the TikTok browser pixel, pass the LeanApp event's `event_id` as the pixel's `event_id` for the same event so TikTok deduplicates them.
4. **Test events**: in Events Manager → the pixel → **Test events**, copy the test event code, set it as the postback's "Test event code", trigger a purchase on the site from a link with `ttclid`, confirm the event appears with the expected match keys, then remove the code.
5. Make sure the site's privacy notice and consent flow cover sharing hashed contact data with TikTok before setting "Hashed user data" to anything other than Off.

### Snap (per customer)

1. In Snap Ads Manager → **Events Manager**, create a **Snap Pixel** for the site. Note the **Pixel ID** and enter it as "Snap Pixel ID". For app events, note the **Snap App ID**.
2. Generate a **Conversions API token** for the pixel (Events Manager → the pixel → Conversions API / setup, "Generate token"; Business Manager admin access may be required). Enter it as the postback's "Conversions API token".
3. If the site also runs the Snap browser pixel, pass the LeanApp event's `event_id` as the pixel's `client_dedup_id` for the same event so Snap deduplicates them.
4. **Test events**: use Events Manager's test or diagnostics view for the pixel to confirm a test purchase from a link with `ScCid` arrives with the expected match keys. LeanApp does not call Snap's validation endpoint or have a Snap test-code setting.
5. Same privacy and consent check as for TikTok before turning on hashed user data.

### Optional, for LeanApp's own "Connect with …" (ad reporting only)

These are covered in [integrations.md](integrations.md#owner-actions) (TikTok for Business developer app, Snap Business Manager OAuth app). They are not needed for website or app events, which use each customer's own tokens.

## Verification checklist (after the actions above)

- [ ] TikTok website events: a test purchase appears in Events Manager → Test events as `CompletePayment` with `ttp` / `ttclid` and, if allowed, hashed email. A browser-pixel copy with the same `event_id` is deduplicated.
- [ ] Snap website events: a test purchase appears in Events Manager for the pixel as `PURCHASE` with `sc_cookie1` / `sc_click_id`.
- [ ] Check the request shapes above against both providers' current documentation: TikTok `page` / `user.user_agent`, and Snap `MOBILE_APP` for app events.
- [ ] The Integrations Center shows "website events" `verified` for each network only after the above succeeded.
- [ ] Update this page's status lines and the "not verified" notes in [integrations.md](integrations.md) and [attribution.md](attribution.md).
