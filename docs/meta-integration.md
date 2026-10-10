# Meta integration

What LeanApp does with Meta, what each part needs, and the steps only the product owner (or each customer) can take on Meta's side. **No Meta app review, business verification or permission has been requested or granted for LeanApp, and none of this has been verified against Meta's live APIs** (all tests use local fakes; see [integrations.md](integrations.md#simulated-vs-live)).

LeanApp's own analytics and attribution never depend on Meta: the LeanApp SDKs collect product events without the Meta SDK, and nothing here requires it.

## Three separate capabilities

Each is set up, permissioned and reported on its own in Settings → Integrations. Connecting one does not turn on, or grant permissions for, another.

| Capability | Direction | Meta API | Where it is set up | Credential |
| --- | --- | --- | --- | --- |
| Ad reporting and cost import | inbound | Marketing API Insights (`/act_{id}/insights`) | Settings → Integrations → Meta Ads | access token with `ads_read` (OAuth through LeanApp's Meta app, or a system user token the customer pastes) |
| App events | outbound | Conversions API, `action_source: "app"` | Postbacks → Meta, Event source "App events" | dataset access token (customer's) |
| Website events | outbound | Conversions API, `action_source: "website"`, alongside the customer's browser Pixel | Postbacks → Meta, Event source "Website events" (or "By platform") | dataset (Pixel) access token (customer's) |

Code: `src/modules/integrations/ads/meta.ts` (reporting), `src/modules/attribution/networks.ts` (request builder), `conversions.ts` (eligibility, validation, hashing), `delivery.ts` (send-time context, consent, retries, log).

### What LeanApp sends, and what it does not claim

- Only events the LeanApp attribution engine attributed and queued for the postback (by network or listed sources). The connector does not choose which ad gets credit.
- Every event carries a stable `event_id` for deduplication. For website events it is the LeanApp event's own `event_id`: if the site also runs the Meta Pixel, pass the same value as the Pixel's `eventID` (`fbq('track', 'Purchase', {...}, { eventID: '<LeanApp event_id>' })`) so Meta counts the pair once.
- Website events carry `event_source_url`, `client_user_agent`, `fbp` / `fbc` (Meta's `_fbp` / `_fbc` cookies, or `fbc` built from the attributed `fbclid`), and, only if the postback's **Hashed user data** setting and the user's `attribution` consent allow it, SHA-256 hashes of the `email` / `phone` user properties and the user id (`em`, `ph`, `external_id`). `client_ip_address` is not sent (LeanApp does not keep visitor IPs).
- App events carry `anon_id` (the install id), `fbc` when there was an `fbclid`, `app_data` with `advertiser_tracking_enabled: 0` (LeanApp has no ATT status for the user), and the same optional hashed data.
- Users who denied `attribution` consent are never sent (checked again at send time).
- **Sending a conversion does not mean Meta will attribute it to an ad.** Meta applies its own matching, attribution windows and privacy rules; Events Manager shows what it received and matched. LeanApp's dashboards keep LeanApp's observed attribution separate from anything Meta reports.

## Owner actions on Meta's side

None of these can be done in code. Status today: **not started** for all.

### For customers using Conversions API (app or website events)

No LeanApp Meta app is involved: each customer uses their own dataset and token.

1. In Meta Events Manager, create or pick a **dataset** (for websites: the Pixel). For app events, connect the app to the dataset (Events Manager → Data sources).
2. Generate a Conversions API access token for that dataset (Events Manager → dataset → Settings → Conversions API, or a system user in Business Settings with access to the dataset).
3. In LeanApp → Postbacks → Meta: dataset (Pixel) ID, token, Event source, events, and optionally Hashed user data.
4. Verify with a **Test event code** (Events Manager → Test events) set on the postback; send a test conversion; remove the code afterwards. Check Event Match Quality and deduplication with the browser Pixel in Events Manager.
5. If Events Manager asks for **domain verification** for the website, verify the domain in Business Settings → Brand safety → Domains.
6. Make sure the site's / app's privacy notice and consent flow cover sharing hashed contact data with Meta before choosing a Hashed user data setting other than Off.

### For "Connect with Meta" (ad reporting import through LeanApp's own Meta app)

Only needed if LeanApp offers one-click OAuth instead of pasted tokens (`META_APP_ID`, `META_APP_SECRET`; see [integrations.md](integrations.md#owner-actions)).

1. Create a Meta developer app of type **Business**, add the **Marketing API** product, and add the redirect URI `https://app.leanapp.io/integrations/oauth/meta_ads/callback` (adjust to the deployed host).
2. Complete **Business Verification** for the business that owns the app (Meta Business Settings → Security Center). Required before advanced access can be granted.
3. Submit **App Review** for **advanced access to `ads_read`** (screencast of the connect flow and of where the data is shown, privacy policy URL, data use description). Until it is approved, only people with a role on the app can connect.
4. Check the app's Marketing API **access tier** and rate limits in the App Dashboard.
5. LeanApp does not request `ads_management` or `business_management`; creating datasets or tokens on a customer's behalf would need them (and their own App Review) and is not built.

### Per customer authorization

Each customer authorizes only their own ad accounts (OAuth consent, or a token they create). LeanApp reads only the ad account ids they enter. Revoking access in Meta (Business Settings → Integrations / System users) stops imports and deliveries; LeanApp then shows the capability in `error` with Meta's message.

## Verification checklist (after the actions above)

- [ ] Ad reporting: Settings → Integrations → Meta Ads → Test connection lists the ad account; Import now; one day's spend matches Ads Manager.
- [ ] App events: a test install from a tracking link with `fbclid` appears in Events Manager → Test events.
- [ ] Website events: a test purchase appears in Test events with `action_source` website, and Pixel + server events are deduplicated.
- [ ] Integrations Center shows each capability `verified` only after the above succeeded.
- [ ] Update this page's status lines and the "not verified" notes in [integrations.md](integrations.md).
