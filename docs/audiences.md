# Audiences

**Status: built (Phase 4).** Code: `apps/platform/src/modules/audiences`. Tables: `audiences`, `audience_members`, `audience_events`, `audience_snapshots`. The original `audience_conditions` table is unused, because the definition is stored as JSON on `audiences.definition`. Permissions: `audiences.read`, `audiences.manage`. Dashboard: app → Engage → Audiences.

## Definition

A tree of `and` / `or` / `not` nodes, with at most 5 levels and 20 leaves, built from these leaves:

| Leaf | Meaning |
| --- | --- |
| `event` | Did (or didn't) do event *E* at least / exactly / at most *n* times within the last *N* days (default 30, max 365), with up to 5 event property filters |
| `user_property` | Latest profile property (from `identify`) compared with `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `not_contains`, `in`, `exists`, `not_exists` |
| `first_seen` / `last_seen` | Within or before the last *N* days |
| `platform` | Has used the app on `ios`, `android`, `web`, `react_native`, `flutter` or `backend` |
| `revenue` | Total `revenue` property, optionally within *N* days, compared with a number |

Automation branch steps can also use a "since the trigger" window on event leaves, for example "did `order_completed` since the trigger".

## Compilation

`compileAudience()` turns the tree into a single parameterized SQL statement:

- Event names, property names and values are always bind parameters.
- Operators come from a fixed whitelist that maps to SQL fragments.
- Numeric comparisons use a safe cast, so a non-numeric value doesn't match instead of failing.
- Nothing the user types is interpolated into the SQL.

Unit tests cover injection attempts in every user-supplied field.

## Identity

Audiences count **people** with the same rule as analytics and privacy requests:

- the `user_id` if there is one;
- otherwise the user linked to the install, if exactly one user is linked;
- otherwise the install itself (`anon:<anonymous_id>`).

An install shared by two or more users stays a separate anonymous person, so one user's activity is never attributed to another. Users with a pending deletion request are excluded.

## Lifecycle

1. **Draft:** build the audience, then **Preview** to see its size and a sample (15 s statement timeout).
2. **Activate:** computes the first membership as a baseline. Baseline entries are logged with `initial = true` and don't fire automations or webhooks.
3. **Recompute:** the cron runs every 5 minutes and recomputes each audience every `refresh_minutes` (minimum 5). A single set-based statement:
   - inserts new members with `entered_at`;
   - sets `exited_at` for members who no longer match;
   - logs each change in `audience_events` (`entered` / `exited`);
   - records a size snapshot.

   Concurrent workers skip an audience that's already being computed (`for update skip locked`). Editing an active audience's definition re-baselines it.
4. **Archive:** blocked while an active or paused automation uses the audience.

Transitions trigger [automations](automation.md) (`audience_entered` / `audience_exited`) and `audience.entered` / `audience.exited` [webhooks](webhooks.md). The detail page shows the size history, the current members and recent transitions.

**Retention:** the scheduled worker purges snapshots and transitions older than 90 days. Current membership is kept.

## Not built yet

- Real-time evaluation as events arrive. Membership can be up to `refresh_minutes` out of date.
- Export to ad-network custom audiences.
- Attribution-channel and push-reachability leaves.
- Audience templates generated from the tracking plan.
