# Analytics

**Status: planned.** No analytics UI or query service is built. Events are stored in `platform.events` with the fields analytics needs (user and anonymous ids, session, platform, versions, properties, attribution context), and `app_users`, `anonymous_users`, `identity_links` and `sessions` are maintained by the processor. The dashboard shows these sections as "Soon".

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

- Queries run against ClickHouse once events move there ([ADR-002](adr/ADR-002-event-store.md)). Until then a Postgres-backed version is possible for small tenants.
- Canonical names (accepted mappings) are used everywhere, so `purchase` and `order_completed` count as one event once mapped.
- Identity: queries resolve `anonymous_id → user_id` through `identity_links`, so pre-signup behaviour joins the user's history.
- Every query is scoped by organization and environment; production is the default and development data never appears in production reports.
