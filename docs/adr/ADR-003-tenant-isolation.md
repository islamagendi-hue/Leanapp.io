# ADR-003: Tenant isolation with Postgres RLS

**Status:** Accepted · 2026-10-05

## Context
A leak between customers would end the company. Options: database per tenant, schema per tenant, or shared schema with `organization_id`.

## Decision
Shared schema, `organization_id` on every tenant table, Row-Level Security policies `organization_id = platform.current_org_id()`, enforced by running every tenant request as the `NOBYPASSRLS` role `platform_app` with `app.org_id` set per transaction. Composite foreign keys `(organization_id, parent_id)` keep child rows in the parent's tenant. System-only tables have no grant to the app role. A test sweeps every table with an `organization_id` column.

## Consequences
- Isolation holds even if application code forgets a filter.
- One schema to migrate; cheap per tenant.
- Every request runs in a transaction; long-running analytics will move to ClickHouse with the tenant filter enforced in the query service.
- Dedicated databases for large customers remain possible because all access goes through `withTenant` / `withSystem`.
