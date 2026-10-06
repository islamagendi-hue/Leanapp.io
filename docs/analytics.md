# Analytics

**Status: built on Postgres** (`src/modules/analytics/`, app → Analytics). Overview page at `…/analytics` lists the reports, saved reports and cohorts of the selected environment.

- **Events:** every event in the range with counts and distinct people; a daily chart for one event, optionally split by platform, app version, country or an event property (top 5 values, the rest as Other).
- **Funnels:** 2–6 ordered steps, a conversion window of 1–30 days, conversion from start and from the previous step, median time between steps, optional split by platform.
- **Retention:** cohorts by the day of a person's first start event; day 1, 3, 7, 14 and 30 returns, as a heat map with a weighted average. Days that aren't over yet are left empty.
- **Revenue** (`revenue.ts`, `revenue-rules.ts`): totals per currency (gross, refunds, net, transactions, paying people, ARPU, ARPPU), a daily net chart per currency, and a breakdown by platform, event or any event property.
- **Cohorts** (`cohorts.ts`): saved groups of people, usable as a filter in events, funnels, retention and revenue.
- **User profiles** (`profiles.ts`, needs `users.read`): search by user ID or anonymous ID (prefix), and a profile with identity, user properties, first/last seen, latest platform and app version, sessions, revenue per currency and a paged event timeline.
- **Saved reports** (`saved-reports.ts`): named trend, funnel, retention and revenue configurations per environment, opened as links that re-run the report on current data.

Rules all reports follow: canonical names (accepted mappings), `track` events only, a person is the `user_id` with anonymous activity stitched in when the install is linked to exactly one user (shared devices are never merged), days in the app's timezone, production by default with a banner on other environments, `analytics.read` permission, RLS scope and a 15-second statement timeout per query.

### Revenue

Which events count, in order (shown on the revenue page under "What counts as revenue"):

1. Events the app's **published tracking plan** marks revenue-relevant.
2. Events the **event catalog** marks `revenue: true` (`purchase_completed`, `order_completed`, `subscription_started`/`_renewed`, `in_app_purchase_completed`, `booking_completed`, `transfer_completed`, `ad_impression`, …).
3. Any other `track` event with a numeric `revenue` property.

The amount is the first of `revenue`, `price` (subscriptions) or `fee` (money movement: your fee, not the amount moved) in the event's spec; numeric strings are accepted. An event whose spec has `refund_amount` (`refund_completed`) is a **refund** and is subtracted on the day it happens. Expected or gross values (`value` on `lead_qualified`, `amount`, `gmv`) are not revenue. A transaction counts once per event name and `transaction_id` (events without one count individually).

**No currency conversion.** Each event's `currency` (ISO 4217, case-insensitive) is kept; totals, charts and breakdowns are per currency and different currencies are never added together. Events without a valid currency are shown under "No currency". ARPU divides a currency's net revenue by everyone active in the range (any track event); ARPPU by the people who had a revenue event in that currency.

### Cohorts

A definition (stored in `platform.analytics_cohorts`, per app environment):

- **Event condition** (optional): did event X at least N times, in the last 1–365 days or between two dates (calendar days in the app's timezone), optionally only counting events where an event property matches.
- **User property condition** (optional): identified users by their profile properties (identify traits), and anonymous installs not linked to exactly one user by their anonymous traits.
- With both, a person must match both. At least one is required.

Property conditions: is, is not, contains (case-insensitive), >, ≥, <, ≤ (numbers or numeric strings), is set, is not set. "is not" and comparisons only match people who have the property.

Members are computed on demand with the analytics statement timeout and never stored, so a cohort is always current; the cohorts page computes each size in its own query and shows "–" if one takes too long. A cohort can only filter reports in its own environment; a deleted cohort in a saved report falls back to everyone with a notice.

### Profiles and identity

A user's profile includes the anonymous activity of installs linked only to that user ("Merged"). An install linked to several users is listed on each of their profiles as "Shared device · not merged" and keeps its anonymous events on its own anonymous profile. Opening an install linked to exactly one user goes to that user's profile. The timeline pages with a keyset cursor (50 events a page, newest first, push-token events left out). Revenue on a profile is all-time, per currency.

### Permissions

`analytics.read` views reports, cohorts and saved reports. `analytics.write` (owner, admin, analyst, marketer) creates, edits and deletes cohorts and saved reports; these changes are audited (`cohort.*`, `saved_report.*`). Profiles and user search need `users.read` (owner, admin, developer, analyst).

Not built yet: activation reports, attribution breakdowns (channel and campaign) for revenue, multi-condition cohort trees (the [audiences](audiences.md) builder will cover AND/OR/NOT), sharing cohorts with audiences, CSV export.

## Scope (phase 2)

| Feature | Description |
| --- | --- |
| Event explorer | Counts and uniques over time, filter and group by property |
| Funnels | Ordered steps with conversion windows, broken down by property, platform, campaign |
| Retention | N-day and unbounded retention from a start event to a return event |
| Cohorts | Saved user groups by behaviour or property (shared with [audiences](audiences.md)) |
| Revenue | Revenue by day, platform and property per currency (built); by channel and campaign once attribution exists |
| User profiles | Timeline per user across devices |
| Activation | Time to activation event, activation rate by acquisition channel |

## Implementation notes

- Queries run on Postgres today and move to ClickHouse with the events ([ADR-002](adr/ADR-002-event-store.md)); the module's functions are the seam.
- Canonical names (accepted mappings) are used everywhere, so `purchase` and `order_completed` count as one event once mapped.
- Identity: queries resolve `anonymous_id → user_id` through `identity_links`, so pre-signup behaviour joins the user's history.
- Every query is scoped by organization and environment; production is the default and development data never appears in production reports.
