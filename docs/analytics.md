# Analytics

**Status: built on Postgres** (`src/modules/analytics/`, app → Analytics). Overview page at `…/analytics` lists the reports and saved reports of the selected environment.

- **Events:** every event in the range with counts and distinct people; a daily chart for one event, optionally split by platform, app version, country or an event property (top 5 values, the rest as Other).
- **Funnels:** 2–6 ordered steps, a conversion window of 1–30 days, conversion from start and from the previous step, median time between steps, optional split by platform.
- **Retention:** cohorts by the day of a person's first start event; day 1, 3, 7, 14 and 30 returns, as a heat map with a weighted average. Days that aren't over yet are left empty.
- **Revenue** (`revenue.ts`, `revenue-rules.ts`): totals per currency (gross, refunds, net, transactions, paying people, ARPU, ARPPU), a daily net chart per currency, and a breakdown by platform, event or any event property.
- **Audience filter**: any [audience](audiences.md) limits events, funnels, retention, revenue and the Users list to its people.
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

### Audiences as report filters (formerly cohorts)

Cohorts merged into [Audiences](audiences.md) (migration `0024_cohorts_into_audiences.sql`). There is one segmentation layer: the audience condition tree (AND / OR / NOT over events, properties, revenue, platform, first and last seen) and its one SQL compiler serve Analytics, Users and Engagement.

- Every report (events, funnels, retention, revenue) and the Users list take "People in audience". The URL parameter is still `cohort` and saved reports still store `cohortId`, so old links and saved reports keep working.
- Every saved cohort was copied into `platform.audiences` with the **same id** as a draft. The conversion keeps the same people: "is not" becomes "is set AND is not", because cohorts never matched people without the property. `analytics_cohorts` is kept unchanged but nothing writes to it.
- Members are computed when the report runs, inside the report's query and with its statement timeout, so a draft audience works as a filter too. Event conditions count by the same rule as the reports (`COUNTED_EVENTS`), and date ranges are calendar days in the app's timezone.
- Archived audiences, or audiences in another environment, don't filter: the report shows everyone with a notice.
- `/analytics/cohorts` and `/analytics/cohorts/<id>` redirect to Audiences.

### Result cache

Report pages (Events, Funnels, Retention, Revenue) reuse a finished result for up to 10 minutes (`modules/analytics/cache.ts`, table `platform.report_cache`, migration 0025). Postgres stays the source of truth: nothing is precomputed, and an expired result is simply computed again.

- The key is a SHA-256 of the environment, the report kind, its full input (event or steps, range, interval, breakdown, property filters, comparison, audience), the timezone, and the audience's last change. Editing an audience therefore recomputes reports filtered by it at once.
- A page served from the cache says how old its results are, with "Refresh now" (`?fresh=1`) to recompute.
- Reading needs `analytics.read`, and RLS keeps rows inside their organization.
- If the cache can't be read or written, the report is computed as if there were no cache.
- Expired rows are deleted by the scheduled cleanup (`purgeOperationalData`).
- The service functions (`eventTrend`, `funnel` and the others) are not cached. Only the pages go through the cache, so API and test callers always see Postgres.

### Overview

The project home (`apps/[app]/page.tsx`) shows the selected environment for the last 7 or 30 days. Each number is compared with the period of the same length just before it. Every number comes from the reports above, through the result cache:

- **Active users, new users and events.** These are KPIs `active_people`, `new_people` and `all_events`. New users are people first seen in the range: identified users take the earliest of their profile and their own installs, and other installs count as anonymous people. This is the same people model as Audiences (`peopleCtes`).
- **Active users per day.** A trend of the "any event" pseudo-event (`ANY_EVENT`, `$any`). Real event names start with a letter, so it can't collide with one.
- **Activation.** The all-time activation rate and the number of activated people, when Activation is on.
- **Key funnel.** It starts at an install or sign-up event the app sends, then follows the Activation steps (activation, core action, revenue), without repeats. It's hidden when fewer than two steps are known.
- **D1, D7 and D30 retention.** Retention over any event in the last 30 days, by the shared calendar-day rule.
- **Top events.**
- **Revenue.** Shown only when there is revenue in the range.

While production has no events, the Overview shows "Connect your app" with a link to Settings → Dev Ops → Get started.

### Dashboards

A dashboard (`modules/dashboards`, tables `dashboards` and `dashboard_widgets`, migration 0026) belongs to a project and shows the selected environment. A project has at most 50 dashboards, with up to 30 widgets each.

- **Visibility:** shared with the workspace (everyone with `analytics.read`) or private (only the person who made it). Viewing needs `analytics.read`. Creating and editing needs `analytics.write`, and a private dashboard can only be edited by its creator. Changes are audited as `dashboard.*`.
- **Widgets:** a widget points at a saved report (its config is used) or carries an inline config, validated by the same schemas as the reports.
  - Types: trend, funnel, retention, revenue, KPI, growth (Activation numbers) and audience size.
- **Layout:** widgets flow in their saved order (y, then x) through a 12-column grid, each spanning its width (w) and height (h). On phones they stack. In edit mode each widget has Move up/down, Wider/Narrower (3 columns a step, 3 to 12) and Taller/Shorter (1 to 8 rows); a move renumbers the order so it stays dense.
- **Running:** each widget runs its report when the dashboard opens, through the result cache. A widget that can't run shows why, for example a deleted saved report or an audience that isn't in this environment. The rest of the dashboard still loads.
- **Adding widgets:** "Edit dashboard" offers a form per type (Number, Trend, Funnel, Retention, Revenue, Activation number, Audience size) with a title, range, optional audience and size. The fields become the widget's config (`dashboards/form.ts`) and are validated by the report schemas. Saved reports can still be added with "Add to dashboard".
- **Templates** (`dashboards/templates.ts`): Growth (DAU, WAU, MAU, activation rate, sign-up to activation, D7, feature adoption), Product (active and new users, feature usage, retention, key funnel) and Monetization (revenue and ARPU, paying users, conversion to paying, revenue by audience). A template is built from the selected environment: its most used events, the published Activation steps and its audiences. The dashboards page previews each template, and a widget that needs something the project doesn't have is listed as left out with the reason instead of being filled with made-up events. The dashboard and its widgets are created in one transaction.

### Profiles and identity

A user's profile includes the anonymous activity of installs linked only to that user ("Merged"). An install linked to several users is listed on each of their profiles as "Shared device · not merged" and keeps its anonymous events on its own anonymous profile. Opening an install linked to exactly one user goes to that user's profile. The timeline pages with a keyset cursor (50 events a page, newest first, push-token events left out). Revenue on a profile is all-time, per currency.

### Permissions

`analytics.read` views reports and saved reports, and filters them by an audience. `analytics.write` (owner, admin, analyst, marketer) saves and deletes reports (audited as `saved_report.*`). Audiences need `audiences.manage` (owner, admin, analyst, marketer). Profiles and user search need `users.read` (owner, admin, developer, analyst).

Not built yet: activation reports, attribution breakdowns (channel and campaign) for revenue, CSV export.

## Scope (phase 2)

| Feature | Description |
| --- | --- |
| Event explorer | Counts and uniques over time, filter and group by property |
| Funnels | Ordered steps with conversion windows, broken down by property, platform, campaign |
| Retention | N-day and unbounded retention from a start event to a return event |
| Audiences | Saved user groups by behaviour or property, one layer for Analytics, Users and Engagement ([audiences](audiences.md)) |
| Revenue | Revenue by day, platform and property per currency (built); by channel and campaign once attribution exists |
| User profiles | Timeline per user across devices |
| Activation | Time to activation event, activation rate by acquisition channel |

## Implementation notes

- Queries run on Postgres today and move to ClickHouse with the events ([ADR-002](adr/ADR-002-event-store.md)); the module's functions are the seam.
- Canonical names (accepted mappings) are used everywhere, so `purchase` and `order_completed` count as one event once mapped.
- Identity: queries resolve `anonymous_id → user_id` through `identity_links`, so pre-signup behaviour joins the user's history.
- Every query is scoped by organization and environment; production is the default and development data never appears in production reports.
