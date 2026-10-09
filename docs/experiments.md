# Experiments (A/B tests)

**Status: built, beta.** The dashboard (Engagement → Experiments), the assignment API, `getVariant` in the JavaScript SDK and the results page are built and tested. The native SDKs (Android, iOS, Flutter) don't have `getVariant` yet: apps call the API and send the exposure event with `track()`. A/B tests of campaign messages are not built (see [Not built](#not-built)).

- **Code:** `apps/platform/src/modules/experiments` (`definition.ts` form and rules, `bucketing.ts` assignment, `stats.ts` statistics, `service.ts` lifecycle and results, `assignment.ts` + `http.ts` the public endpoint, `capabilities.ts` what the page says works).
- **Table:** `experiments` (migration `0032_experiments.sql`), per environment, RLS `tenant_isolation`.
- **Permissions:** `automations.read` to see experiments and results, `automations.manage` to create, edit, start and stop them (owner, admin, marketer). An experiment changes what end users see, like a campaign, so it uses the engagement rights rather than the analytics ones.
- **Audit:** `experiment.created`, `experiment.updated`, `experiment.started`, `experiment.stopped`.

## Definition

| Field | Rules |
| --- | --- |
| Name, hypothesis | Name 2–80 characters; hypothesis optional, up to 1,000 |
| Key | What the app's code asks for (`checkout_button`): lowercase letter first, then `a-z0-9_`, 2–60, unique per environment |
| Variants | A control (the first) and 1 to 4 more, each with a key, a name and a whole-number weight (1–1,000). Weights are shares: 50/50, 90/10, 1/1/1 |
| Traffic | 1–100% of eligible people take part; the rest get no variant |
| Audience | Optional. Only members of an **active** [audience](audiences.md) are eligible (membership as of its last recompute) |
| Goal | A counted event, optionally with one property filter, done within 1–90 days (the form offers 1, 3, 7, 14, 30) of the person's first exposure |
| Secondary metric | Optional: another event (same window), or revenue by the [revenue rules](analytics.md#revenue) |

**Lifecycle:** draft → running → stopped. Only a draft can be edited. Starting checks the audience is active and records `started_at`. Stopping records `stopped_at`; the API stops returning the experiment, so the app shows its default. A stopped experiment can't be started again (create a new one), because people's assignments and the result window would no longer mean one thing.

## Assignment

`GET /v1/experiments/assignments?user_id=…&anonymous_id=…` or `POST` with `{ "user_id"?, "anonymous_id"? }`, with the public SDK key (or a secret key with `events:write`):

```json
{ "assignments": [
  { "experiment": "checkout_button", "experiment_id": "7b0c…", "variant": "treatment" },
  { "experiment": "vip_offer", "experiment_id": "c41e…", "variant": null }
] }
```

- Every **running** experiment of the key's environment is listed. `variant: null` means the person isn't in it (outside its traffic or audience): show the default.
- **The person** is resolved like Analytics resolves people: the `user_id`; else the one user the install is linked to (`identity_links`, exactly one); else the install (`anon:<anonymous_id>`). So an install linked to one user gets that user's variant.
- **Deterministic and sticky:** nothing is stored. The variant is `sha256(salt:variant:person)` mapped to [0, 1) and picked by cumulative weight; whether the person is in the traffic is a second, independent hash (`salt:traffic:person`). The same person gets the same variant on every call and every server. Each experiment has its own random salt, so experiments don't line up with each other. Raising traffic on a running test would keep everyone who was in, but variants, weights, traffic and audience are locked once it runs anyway.
- **Sign-in:** a person who was anonymous and then signs in may get a different variant under their user id. Call `getVariant` after `identify()` for experiments on signed-in users. The results count each person in their first exposure and show how many saw more than one variant.
- **Limits:** CORS open, no cookies, `Cache-Control: no-store`, 6,000 requests per minute per environment (`EXPERIMENT_ASSIGNMENTS_PER_MINUTE`, `429` with `Retry-After`), one `api_request_logs` row per request. `401` for a missing or invalid key, `422` without an id.
- **Caveat:** a public key can't prove who the user is, so anyone with the key can ask for any id's variants, and with an audience target the answer shows whether that id is a member. Don't target experiments on sensitive audiences.

## Exposure: sent by the app, not recorded on assignment

The app sends a standard `track` event when it actually shows a variant:

```json
{ "type": "track", "event_name": "experiment_exposure", "user_id": "u-42", "anonymous_id": "…",
  "event_id": "exp:<experiment_id>:<hash>", "properties": { "experiment": "checkout_button", "experiment_id": "7b0c…", "variant": "treatment" } }
```

**Why the client sends it.** The assignment endpoint answers for every running experiment at once (typically at app start), so recording exposure there would count people who never reached the screen being tested and dilute the difference between variants. An event sent when the variant is shown counts only people who saw it, and it rides the normal pipeline: the offline queue and retries, `event_id` de-duplication, analytics consent (a denied user's exposure isn't stored), privacy deletion and tombstones. The name starts with a letter because ingestion requires it (`$experiment_exposure` would be rejected); the processor treats it as a system event, so it gets no mapping suggestions. It is a counted event, so it appears in Events & trends like any other.

## Results

Server-rendered on the experiment's page, from Postgres under the organization's RLS scope with the analytics statement timeout.

- **Exposed:** people with an `experiment_exposure` event naming the experiment's id and one of its variants, at or after `started_at` and before `stopped_at` (or now). Each person counts once, in the variant of their **first** exposure; people exposed to more than one variant are counted and shown.
- **Converted:** the person did the goal event (canonical names, counted events, the property filter) at or after their first exposure and within the window. Conversions after the stop still count while inside a person's window. "Can still convert" is people exposed less than one window ago.
- **Per variant:** exposed, converted, conversion rate; for each non-control variant the **uplift** (rate ratio − 1) with a 95% interval on the log ratio, the **difference in points** with a 95% Wald interval, the **p-value** of a two-sided two-proportion z-test (pooled), and a verdict.
- **Not enough data yet:** a comparison is tested only when both groups have at least 100 exposed people and at least 5 conversions and 5 non-conversions (where the normal approximation holds). Until then the verdict says so.
- **Several variants:** with k treatments, a result is significant below p 0.05 / k (Bonferroni), so testing more variants doesn't add false winners.
- **Peeking:** the page tells people to decide the end date or sample size before starting; the z-test assumes one look, and stopping at the first significant day inflates false positives. Sequential testing is not built.
- **Sample ratio mismatch:** a chi-square goodness-of-fit test of exposed counts against the weights. With at least 100 exposed people and p < 0.001 the page warns that exposures are probably missing for a variant (for example a code path that doesn't send the event) and the results may be biased.
- **Revenue** (secondary metric): net revenue (refunds subtracted) of exposed people within the window, per currency with no conversion, total and per exposed person. Not tested for significance.
- **Chart:** exposed people so far per variant, by calendar day in the project's timezone.

## SDKs

JavaScript (`sdks/javascript`): `await Analytics.getVariant("checkout_button")` returns the variant key or `null`. It fetches all assignments in one request (cached for `experimentsCacheMs`, default 5 minutes, and refetched when the user changes), sends the exposure once per user with a stable `event_id`, and returns `null` (never throws) when the request fails. `{ expose: false }` with `Analytics.trackExposure(key, id, variant)` separates fetching from showing. Android, iOS and Flutter: call the endpoint and send the event above with `track()`.

## Not built

- **A/B tests of campaign messages** (variants of one message with a holdout). A campaign is an automation with a single message step, and the engine, run log and delivery counts all assume one message per run; variants would need a variant on each run, per-variant delivery and conversion reporting, and a holdout that receives nothing. It was left out of this MVP rather than half-built.
- `getVariant` in the native SDKs; sequential or Bayesian analysis; CUPED or other variance reduction; mutually exclusive experiment layers; significance tests on revenue; per-experiment feature flags or remote config values.
