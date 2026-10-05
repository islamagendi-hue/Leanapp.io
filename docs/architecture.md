# Architecture

## Current (phase 1, built)

```
 Mobile app ── @leanapp/analytics ──┐
 Backend ── REST + secret key ──────┤   POST /v1/events, /v1/events/batch
                                    ▼
                    ┌───────────────────────────────┐
                    │ Next.js app (apps/platform)   │  one deployment serves
                    │  • ingestion route handlers   │  app.leanapp.io (dashboard)
                    │  • dashboard (RSC + actions)  │  and api.leanapp.io (API)
                    │  • management API (/v1/…)     │
                    │  • processor (after() + cron) │
                    └──────────────┬────────────────┘
                                   │ pg, RLS per request
                    ┌──────────────▼────────────────┐
                    │ Postgres, schema `platform`   │
                    │  control plane + events +     │
                    │  queue (processed_at)         │
                    └───────────────────────────────┘
```

**Request path.** Ingestion authenticates the key (hash lookup), enforces body limits and the per-environment rate limit, validates and normalizes each event, inserts with `ON CONFLICT (environment_id, event_id) DO NOTHING`, stores the request's idempotency record and responds. Processing is scheduled with `after()` so the response is not delayed, and `/api/internal/process-events` (Vercel Cron) is the safety net.

**Processing.** Workers claim unprocessed rows with `FOR UPDATE SKIP LOCKED`, and each event runs inside its own savepoint so one bad event never blocks a batch. Steps: identity resolution (anonymous users, app users, identity links, aliases), sessions, push tokens (moved out of the event into `push_tokens`), and plan validation (canonical names through accepted mappings, validation results, implementation status, mapping suggestions).

**Modules** (`apps/platform/src/modules`): `auth`, `organizations`, `tenancy`, `rbac`, `audit`, `apps`, `credentials`, `ingestion`, `processing`, `implementation` (engine, catalog, codegen, score), `debugger`, `usage`. Pages and route handlers are thin; business rules live in modules and are unit- or integration-tested.

## Target

```
 SDKs / REST ──► Edge ingestion (stateless, autoscaled)
                    │  validate, authenticate (key cache in Redis), rate limit (Redis)
                    ▼
               Durable log (Kafka / Redpanda, or a managed queue)
                    │
      ┌─────────────┼──────────────────┬───────────────────┐
      ▼             ▼                  ▼                   ▼
  Event store   Identity &        Attribution         Audience &
  (ClickHouse)  sessions          engine + postbacks   automation engine
      │         (Postgres)        (Postgres)           (Postgres + Redis)
      ▼
  Analytics query service ──► dashboard
```

- **Postgres** stays the system of record for tenants, plans, identities, audiences, automations and billing.
- **ClickHouse** holds raw and enriched events for analytics (funnels, retention) at volume ([ADR-002](adr/ADR-002-event-store.md)).
- **Redis** for key cache, rate limits, live audience state and the debugger feed.
- **A durable log** decouples ingestion from processing so a processing outage never loses events.

## Gap between current and target

| Area | Today | Target | Trigger to move |
| --- | --- | --- | --- |
| Event store | Postgres `platform.events` | ClickHouse, Postgres keeps 30 days for debugger | > ~50M events/month or analytics queries > 2s |
| Queue | `processed_at` + SKIP LOCKED | Durable log | Multiple processing consumers or > 1k events/s sustained |
| Rate limit / key cache | Postgres buckets, DB lookup | Redis | Ingestion p95 > 100ms from DB load |
| Ingestion runtime | Next.js route handlers on Vercel | Dedicated service (same code, `modules/ingestion`) | Cost or cold starts on ingestion |
| Region | Wherever the database is provisioned | GCC/EU region for residency | First enterprise customer requiring it |

The ingestion and processing code is written against the module boundaries above, so moving a store or a runtime changes adapters, not the wire format or the SDKs.
