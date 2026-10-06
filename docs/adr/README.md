# Architecture decision records

| ADR | Decision | Status |
| --- | --- | --- |
| [001](ADR-001-stack-and-repo.md) | Next.js + Postgres in a dedicated repository | Accepted |
| [002](ADR-002-event-store.md) | Postgres as interim event store and queue; ClickHouse later | Accepted |
| [003](ADR-003-tenant-isolation.md) | Shared schema with Postgres RLS | Accepted |
| [004](ADR-004-auth.md) | First-party email/password sessions, OAuth/MFA-ready | Accepted |
| [005](ADR-005-implementation-engine.md) | Deterministic rules engine; LLM only as approval-gated suggester | Accepted |
| [006](ADR-006-ingestion-idempotency.md) | Event-level and request-level idempotency | Accepted |
| [007](ADR-007-api-keys.md) | Public SDK keys vs secret keys, per environment | Accepted |
| [008](ADR-008-plan-versioning.md) | Versioned tracking plans with approval | Accepted |
| [009](ADR-009-sdk-design.md) | Single TypeScript core SDK first; native SDKs share its contract | Accepted |
