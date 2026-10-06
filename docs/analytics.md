# Analytics

**Status: v1 built on Postgres** (`src/modules/analytics/service.ts`, app → Analytics):

- **Events:** every event in the range with counts and distinct people; a daily chart for one event, optionally split by platform, app version, country or an event property (top 5 values, the rest as Other).
- **Funnels:** 2–6 ordered steps, a conversion window of 1–30 days, conversion from start and from the previous step, median time between steps, optional split by platform.
- **Retention:** cohorts by the day of a person's first start event; day 1, 3, 7, 14 and 30 returns, as a heat map with a weighted average. Days that aren't over yet are left empty.

Rules all reports follow: canonical names (accepted mappings), `track` events only, a person is the `user_id` with anonymous activity stitched in when the install is linked to exactly one user (shared devices are never merged), days in the app's timezone, production by default with a banner on other environments, `analytics.read` permission, RLS scope and a 15-second statement timeout per query.

Not built yet: cohorts, revenue, user profiles, activation reports, saved reports, property filters.

## Scope (phase 2)

| Feature | Description |
| --- | --- |
| Event explorer | Counts and uniques over time, filter and group by property |
| Funnels | Ordered steps with conversion windows, broken down by property, platform, campaign |
| Retention | N-day and unbounded retention from a start event to a return event |
| Cohorts | Saved user groups by behaviour or property (shared with [audiences](audiences.md)) |
| Revenue | Revenue by day, channel and campaign in the app's default currency; refunds netted |
| User profiles | Timeline per user across devices |
| Activation | Time to activation event, activation rate by acquisition channel |

## Implementation notes

- Queries run on Postgres today and move to ClickHouse with the events ([ADR-002](adr/ADR-002-event-store.md)); the module's functions are the seam.
- Canonical names (accepted mappings) are used everywhere, so `purchase` and `order_completed` count as one event once mapped.
- Identity: queries resolve `anonymous_id → user_id` through `identity_links`, so pre-signup behaviour joins the user's history.
- Every query is scoped by organization and environment; production is the default and development data never appears in production reports.
