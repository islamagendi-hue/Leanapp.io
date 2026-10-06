# ADR-002: Postgres as interim event store and queue

**Status:** Accepted · 2026-10-05

## Context
Analytics at scale needs a columnar store (ClickHouse) and ingestion benefits from a durable log and Redis. None are provisioned, and buying infrastructure needs the owner's approval. Phase 1 volume is design partners in development environments.

## Decision
- Store events in `platform.events` (Postgres), with `processed_at` as the queue marker. Workers claim rows with `FOR UPDATE SKIP LOCKED`; each event is processed in its own savepoint.
- Trigger processing with `after()` after each ingestion response, with a cron endpoint as a safety net.
- Rate limits in a Postgres fixed-window table.
- Keep the wire format, ingestion module and processor independent of the store so ClickHouse/Redis/a log can be swapped in.

## Consequences
- No new infrastructure or cost; transactional consistency between events, identities and plan status.
- Not suitable beyond roughly tens of millions of events per month or for heavy analytical queries. Triggers to move are listed in [architecture](../architecture.md).
- Retention is enforced by the scheduled worker (report-only until `EVENT_RETENTION=enforce`) until ClickHouse TTLs replace it.
