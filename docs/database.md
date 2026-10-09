# Database

Postgres, schema `platform`. Migrations live in `apps/platform/db/migrations` and are applied in order by `npm run db:migrate`, one transaction per file, recorded in `platform.schema_migrations`.

| Migration | Contents |
| --- | --- |
| `0001_foundation.sql` | All tables, indexes, `updated_at` triggers, roles, RLS policies, seed data for plans and usage meters |
| `0002_rbac_seed.sql` | The first roles, permissions and role → permission matrix, generated from `src/modules/rbac/permissions.ts`. Frozen: later permissions come in their own migrations, and `test/rbac.int.test.ts` checks the migrated database matches `permissions.ts`. |

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
| Attribution | `attribution_settings`, `campaigns`, `attribution_links`, `attribution_touchpoints`, `attribution_events`, `attribution_conversions`, `attribution_postbacks`, `attribution_postback_deliveries` (0012; `campaigns` unused so far), `ad_spend_daily` (0031: spend per environment, day, source, campaign and currency, entered by hand or CSV) |
| Engagement | `audiences`, `audience_members`, `audience_events`, `audience_snapshots`, `automations`, `automation_versions`, `automation_runs`, `notifications`, `in_app_messages`, `whatsapp_templates`, `email_templates`, `email_domains` (unused: `audience_conditions`, `automation_triggers`, `automation_actions`; definitions are JSON) |
| Integrations | `integrations` (push and email credentials in `secret_ciphertext`, AES-256-GCM with `INTEGRATIONS_ENCRYPTION_KEY`), `webhooks` (signing secret hashed and encrypted), `webhook_deliveries` |
| Operations | `audit_logs` (append-only for tenants), `api_request_logs`, `rate_limit_buckets` |
| Privacy | `consent_records`, `consent_state`, `suppressions`, `privacy_requests`, `data_deletion_jobs`, `privacy_tombstones` (hashed ids of deleted users and installs; ingestion drops their events) |
| Analytics | `analytics_cohorts` (legacy; copied into `audiences` with the same ids by 0024, no longer written), `analytics_saved_reports`, `report_cache` (finished report results reused for up to 10 minutes; key hash per environment), `dashboards` and `dashboard_widgets` (per project; widgets reference a saved report or hold an inline report config) |

Attribution, engagement and integration tables are in use ([attribution](attribution.md), [audiences](audiences.md), [automation](automation.md), [webhooks](webhooks.md)). All privacy tables are in use; `consent_records`, `consent_state` and `suppressions` are described in [API](api.md#consent-and-suppression) and checked by automations before every message.

## Key constraints

- `events (environment_id, event_id)` unique: retries are de-duplicated.
- `event_batches (environment_id, idempotency_key)` unique: a retried request with the same events (`payload_hash`) returns the stored response; different events under the same key are refused with 409.
- `environments (app_id, type)` unique; `apps (organization_id, slug)` unique.
- `tracking_plans.published_version_id` points at the single published version; publishing archives the previous one.
- `event_mappings (app_id, from_name)` unique.

## Roles

| Role | Used by | Rights |
| --- | --- | --- |
| owner (the migration user) | migrations, `withSystem` (auth, key lookup, processing) | Bypasses RLS |
| `platform_app` (`NOBYPASSRLS`) | every tenant request via `SET LOCAL ROLE` inside `withTenant` | DML on tenant tables under RLS; no access to `auth_sessions`, `auth_tokens`, `user_identities`, `rate_limit_buckets`, `users.password_hash` |

## Retention

Plan features carry retention as data (`plan_features` row `retention.days`; without an active subscription, `organizations.plan_id`, which defaults to `free` with 30 days). The scheduled worker applies it to `events` and `sessions` in batches of 10,000 per organization per run, but only deletes when `EVENT_RETENTION=enforce`; otherwise it reports what is past retention in its response. When events move to ClickHouse this becomes a TTL per tenant tier.

The same worker purges operational rows nothing reads any more: used or expired one-time tokens after 1 day, revoked or expired sessions and unaccepted expired invitations after 30 days, `event_batches` and `api_request_logs` after 30 days, rate-limit windows after 1 hour.
