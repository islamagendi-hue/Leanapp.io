# Multi-tenancy

**Model:** shared database, shared schema, `organization_id` on every tenant row, enforced by Postgres Row-Level Security. See [ADR-003](adr/ADR-003-tenant-isolation.md).

## How a request is scoped

1. The session cookie resolves the user (`modules/auth`).
2. `resolveTenant(userId, orgSlug)` checks membership and returns `{ organizationId, role }`; non-members get a 404, not a 403, so organization slugs are not discoverable.
3. `tenantTx(ctx, permission, fn)` checks the RBAC permission, then `withTenant` opens a transaction, runs `SET LOCAL ROLE platform_app` and `set_config('app.org_id', <id>, true)`.
4. Every policy is `organization_id = platform.current_org_id()`. A query that forgets a `where organization_id = …` still only sees the current tenant. An insert or update with another tenant's id is rejected by `WITH CHECK`.

Ingestion is scoped by the key: the key lookup returns organization, app and environment, and events are written for that environment only.

## Defence in depth

- Composite foreign keys `(organization_id, parent_id)`: a child row can't reference another tenant's parent even through the owner role.
- System-only tables (`auth_sessions`, `auth_tokens`, `user_identities`, `rate_limit_buckets`) have no grant to `platform_app`.
- `audit_logs` is append-only for tenants (no update/delete policy).
- Environment isolation inside a tenant: every data-plane row carries `environment_id`; keys are environment-specific and tagged `dev`/`stg`/`live`; the SDK namespaces its local queue by key prefix.

## Tests

`apps/platform/test/tenant-isolation.int.test.ts` creates two tenants and checks, for **every table with an `organization_id` column** (discovered from the catalog, so new tables are covered automatically), that tenant A cannot read, update, delete or insert tenant B's rows; that composite foreign keys reject cross-tenant references; that system tables are unreachable; and that RBAC blocks each role from what it may not do.

## Larger tenants

If a customer needs physical isolation (residency, contract), the same schema can run in a dedicated database; the application resolves the connection per organization. Not built; the code keeps all DB access behind `withTenant` / `withSystem` so this is an adapter change.
