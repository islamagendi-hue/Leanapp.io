# Growth model (Phase 1)

The growth model answers, per person and from the app's own events: when did
they first show up, did they activate, how often do they do the core action,
did they pay and how much, and did they come back on day 1, 7 and 30. It is the
base later phases build on (attribution joins source → activation → retention →
revenue on top of it).

Everything here is **additive and off by default**. Each app has two switches
(`apps.features`), turned on by an owner, admin or developer (`apps.update`):

| Switch | What it adds | Off means |
| --- | --- | --- |
| `mapping_history` | Mapping history with restore, and a background re-map of **all** past events after every mapping change | Mappings behave exactly as before: an accepted mapping re-maps the last 30 days (up to 5,000 events) at once |
| `growth_model` | Growth state per person, the growth summary page and `GET /v1/growth/summary` | No growth state is written; event processing writes exactly what it wrote before (covered by a test) |

Event mapping itself is unchanged: raw names are kept in `events.event_name`,
mappings set `events.canonical_name`, suggestions still need a person to accept them.

## Mapping history

- `event_mapping_history` is append-only. A trigger on `event_mappings` writes a
  row (numbered revision per mapping) for every change of target or status, so
  every path is covered: processing suggestions, accept, reject, manual
  mappings, restores. The app's database role cannot update or delete it.
- **Restore** (validation page) puts a mapping back to an earlier revision's
  target and status. It is recorded as a new revision with `reverted_to`.
- History is always recorded; the list, restore and full re-map need `mapping_history`.

## Re-processing jobs

`app_reprocess_jobs` holds background work per environment, run by the
scheduled worker (`/api/internal/process-events`) in small committed chunks
under the same per-environment lock as event processing:

| Kind | Queued when | Does |
| --- | --- | --- |
| `remap` | a mapping is accepted, rejected, set or restored (with `mapping_history` on), or `mapping_history` is turned on | Rewrites `canonical_name` for every event up to the newest one at start, 5,000 per chunk. Only `canonical_name` changes. Then queues a growth rebuild when `growth_model` is on |
| `growth_rebuild` | `growth_model` is turned on, a plan version is published, a re-map finishes | Recomputes every person (identified users, then installs, 500 per chunk), then deletes rows no one owns any more |

One active job per environment and kind; asking again restarts it. A chunk
that fails is retried on later runs, five times at most. Progress is shown on
the validation page (re-map) and the growth page (rebuild).

## Growth definitions

Saved with the tracking plan version (`tracking_plan_versions.growth`), so they
are drafted, approved and published like the rest of the plan, and show in the
version diff. The **Growth setup** page previews a definition on the last 30
days of events before saving it to the draft.

| Rule | Meaning |
| --- | --- |
| Activation | First time a person does this event (optionally only when a property matches) |
| Core action | Every time a person does this event (optionally filtered) |
| Revenue | This event's amount property (number or numeric text) in its currency property; a missing or invalid currency counts as the app's default currency. Kept per currency, never converted |
| Retention | Retained on day N (1, 7, 30) = came back on or after `first_seen + N days`, with any event or with the core action |

Property conditions use the same operators and semantics as analytics filters.
A plan version without saved definitions (every version made before Phase 1)
gets **derived** ones: activation = the plan's activation event, core action =
its north-star event, revenue = its first revenue-relevant event with a
`revenue`, `price` or `fee` property. Saving definitions also sets the draft's
activation and north-star events.

## Growth state

`growth_state` has one row per environment and person. The person key is the
analytics key: the user id, else the one user the install is linked to, else
`anon:<anonymous_id>`. An install linked to several users (a shared device) is
never merged into any of them. Counted events: `track` and `screen`, processed
without error.

Kept current by event processing (step 6, after the event is marked processed):

1. events of a batch are applied to existing rows in one statement (min / max /
   sum updates);
2. a person is fully recomputed from all their events, once per batch, when
   they have no row yet, an event is earlier than their first one (late or
   offline events), or an identify created a new identity link (the install's
   events move to the user, or back to the install when it becomes shared).

The recompute is the same set-based query the rebuild job uses, so the
incremental path and a rebuild always agree. Tests compare both against an
independent reference computed from raw events. Processing 20,000 events with
the growth model on took 8% longer than with it off (bound: 20%;
`GROWTH_BENCH=1 npx vitest run --project integration test/growth-bench.int.test.ts`).

Privacy deletion and export include `growth_state`. Retention deletion of old
events does not rewrite growth state (it is a summary, like usage records).

## Where to see it

- Dashboard: **Growth → Summary** (people, activated, core action, paying,
  revenue per currency, D1/D7/D30 retention) and **Growth → Definitions**. With
  the growth model on, the app's setup checklist ends on the summary.
- API (secret key, `management:read`): `GET /v1/growth/definition`,
  `GET /v1/growth/summary`, `GET /v1/event-mappings`, `GET /v1/event-mappings/history`.
- Permissions: `growth.read` (all roles), `growth.write` (owner, admin, developer)
  to save definitions; approving and publishing still need `implementation.approve`.

## Not in Phase 1

Attribution of growth state to sources (Phase 2), growth analytics beyond the
summary, and anything automated on top of it.
