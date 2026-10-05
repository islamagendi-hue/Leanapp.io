# Database

Postgres, schema `platform`. Migrations live in `apps/platform/db/migrations` and are applied in order by `npm run db:migrate`, one transaction per file, recorded in `platform.schema_migrations`.

| Migration | Contents |
| --- | --- |
| `0001_foundation.sql` | All tables, indexes, `updated_at` triggers, roles, RLS policies, seed data for plans and usage meters |
| `0002_rbac_seed.sql` | Roles, permissions and the role → permission matrix, **generated** from `src/modules/rbac/permissions.ts` by `npm run db:seed-rbac`. Do not edit by hand. |

## Conventions

- UUID primary keys (`gen_random_uuid()`), except `events.id` which is a `bigint` identity so the debugger can page with `id > $after`.
- Every tenant-owned table has `organization_id` and RLS. Child tables reference parents with **composite foreign keys** `(organization_id, parent_id)`, so a row can never point at another tenant's parent.
- `created_at` / `updated_at` (`timestamptz`), updated by trigger.
- Money is `numeric(18,4)` with an ISO 4217 `currency`.
- Flexible attributes are `jsonb` (`properties`, `context`, `summary`), never free-form columns.
- Secrets are never stored in clear: passwords (scrypt), session tokens, secret API keys and invitation tokens are stored as hashes. Public SDK keys are stored in clear (they ship inside apps) plus a hash for lookup.

## Tables by domain

| Domain | Tables |
| --- | --- |
| Commercial | `plans`, `plan_features`, `subscriptions`, `usage_meters`, `usage_records` (daily rollup), `invoices` |
| Identity | `users`, `user_identities` (OAuth-ready), `auth_sessions`, `auth_tokens` (verify email, password reset) |
| Tenancy | `organizations`, `organization_members`, `organization_invitations`, `roles`, `permissions`, `role_permissions` |
| Apps | `apps`, `app_platforms`, `environments` (one per type per app), `sdk_keys`, `api_keys` |
| Data plane | `event_batches` (idempotency + request stats), `events`, `anonymous_users`, `app_users`, `identity_links`, `sessions`, `push_tokens` |
| Implementation | `tracking_projects`, `tracking_questions`, `tracking_answers`, `tracking_plans`, `tracking_plan_versions`, `tracking_events`, `tracking_event_properties`, `tracking_user_properties`, `tracking_attribution_rules`, `tracking_implementation_status`, `tracking_validation_results`, `event_mappings`, `implementation_templates`, `implementation_dependencies` |
| Attribution | `attribution_settings`, `campaigns`, `attribution_touchpoints`, `attribution_events`, `attribution_conversions` |
| Engagement | `audiences`, `audience_conditions`, `audience_members`, `automations`, `automation_triggers`, `automation_actions`, `automation_runs`, `notifications` |
| Integrations | `integrations` (credentials by `secret_ref` only), `webhooks`, `webhook_deliveries` |
| Operations | `audit_logs` (append-only for tenants), `api_request_logs`, `rate_limit_buckets` |
| Privacy | `consent_records`, `privacy_requests`, `data_deletion_jobs` |

Tables for attribution, engagement, integrations and privacy exist so the data model is settled early; the features that write to them are planned (see [roadmap](roadmap.md)).

## Key constraints

- `events (environment_id, event_id)` unique: retries are de-duplicated.
- `event_batches (environment_id, idempotency_key)` unique: a retried request returns the stored response.
- `environments (app_id, type)` unique; `apps (organization_id, slug)` unique.
- `tracking_plans.published_version_id` points at the single published version; publishing archives the previous one.
- `event_mappings (app_id, from_name)` unique.

## Roles

| Role | Used by | Rights |
| --- | --- | --- |
| owner (the migration user) | migrations, `withSystem` (auth, key lookup, processing) | Bypasses RLS |
| `platform_app` (`NOBYPASSRLS`) | every tenant request via `SET LOCAL ROLE` inside `withTenant` | DML on tenant tables under RLS; no access to `auth_sessions`, `auth_tokens`, `user_identities`, `rate_limit_buckets`, `users.password_hash` |

## Retention

Plan features carry retention as data (`plan_features` row `retention.days`). Enforcing it with a deletion job is planned together with the move of events to ClickHouse (TTL per tenant tier).
