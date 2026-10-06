# Attribution

**Status: partial.** Built: the SDK captures UTM parameters and click ids from deep links and landing URLs and attaches them to every event (`context.attribution`); the tracking plan generates per-channel attribution rules; the Implementation Score checks that planned parameters arrive. Not built: the attribution engine, ad-network integrations and postbacks. Tables exist (`attribution_settings`, `campaigns`, `attribution_touchpoints`, `attribution_events`, `attribution_conversions`).

## Why it matters here

In the GCC, TikTok and Snapchat often drive as much mobile acquisition as Google and Meta. Many teams pay an MMP but don't trust its numbers because revenue events come from the app rather than the server. LeanApp's angle: attribution that is fed by the same validated event stream, with revenue confirmed by the backend.

## Target design

1. **Touchpoints.** Clicks via LeanApp links (`leanapp.io/l/…`, planned), click ids from deep links, install referrer (Android), and ad-network APIs. Stored in `attribution_touchpoints` with channel, campaign, ad set, ad, click id and timestamp.
2. **Matching** at install / first open, in order of confidence: deterministic (click id, install referrer, user id), then probabilistic only where allowed and disclosed. iOS: SKAdNetwork / AdAttributionKit postbacks; no fingerprinting.
3. **Models.** Last touch (default, 7-day click / 1-day view windows per channel, configurable in `attribution_settings`), first touch, and linear for reporting.
4. **Conversions.** Revenue and conversion events from the plan (backend-sourced where possible) are attributed in `attribution_conversions` with the matched touchpoint.
5. **Postbacks** to Google Ads, Meta CAPI, TikTok Events API and Snapchat CAPI with hashed identifiers and deduplication ids, using credentials referenced from a secret manager (`integrations.secret_ref`).
6. **Existing MMP.** Import AppsFlyer / Adjust / Branch attribution via their raw-data or webhook exports so customers can migrate gradually.

## What to do today

Follow the plan's attribution rules: preserve click ids in your deep links and call `Analytics.captureAttribution(url)` on app open. The data is stored now and will be attributed when the engine ships.
