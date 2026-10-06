# Roles and permissions

Defined once in `apps/platform/src/modules/rbac/permissions.ts`. The SQL seed (`db/migrations/0002_rbac_seed.sql`) was generated from it with `npm run db:seed-rbac`. Migrations that are already applied never change, so permissions added later are inserted by their own migration (`analytics.write` in `0010_analytics.sql`); an integration test (`test/analytics-v2.int.test.ts`) checks the migrated database matches `permissions.ts` for every role.

## Roles

| Role | Rank | For |
| --- | --- | --- |
| Owner | 100 | Everything, including billing and deleting the organization. At least one per organization. |
| Admin | 80 | Everything except billing changes and deleting the organization. |
| Developer | 50 | Apps, environments, keys, events and debugger, implementation (edit, approve, mappings), integrations, webhooks. |
| Analyst | 30 | Read access to events, analytics, users, attribution, audiences. |
| Marketer | 30 | Analytics, attribution (manage), audiences and automations (manage). |

A member can assign roles up to their own rank and can only manage members of a lower rank.

## Permission matrix

| Permission | Owner | Admin | Developer | Analyst | Marketer |
| --- | :-: | :-: | :-: | :-: | :-: |
| organization.read | ✓ | ✓ | ✓ | ✓ | ✓ |
| organization.update | ✓ | ✓ | | | |
| organization.delete | ✓ | | | | |
| members.read | ✓ | ✓ | ✓ | ✓ | ✓ |
| members.invite / update_role / remove | ✓ | ✓ | | | |
| billing.read | ✓ | ✓ | | | |
| billing.manage | ✓ | | | | |
| apps.read | ✓ | ✓ | ✓ | ✓ | ✓ |
| apps.create / apps.update | ✓ | ✓ | ✓ | | |
| apps.delete | ✓ | ✓ | | | |
| credentials.read / manage | ✓ | ✓ | ✓ | | |
| events.read | ✓ | ✓ | ✓ | ✓ | |
| implementation.read | ✓ | ✓ | ✓ | ✓ | ✓ |
| implementation.edit / approve / mapping | ✓ | ✓ | ✓ | | |
| analytics.read | ✓ | ✓ | ✓ | ✓ | ✓ |
| analytics.write (save cohorts and reports) | ✓ | ✓ | | ✓ | ✓ |
| users.read | ✓ | ✓ | ✓ | ✓ | |
| attribution.read | ✓ | ✓ | | ✓ | ✓ |
| attribution.manage | ✓ | ✓ | | | ✓ |
| audiences.read | ✓ | ✓ | | ✓ | ✓ |
| audiences.manage, automations.read / manage | ✓ | ✓ | | | ✓ |
| integrations.read | ✓ | ✓ | ✓ | | ✓ |
| integrations.manage, webhooks.manage | ✓ | ✓ | ✓ | | |
| privacy.manage, audit.read | ✓ | ✓ | | | |

## Enforcement

1. `tenantTx(ctx, permission, fn)` throws `ForbiddenError` before opening the transaction.
2. Pages call `requirePermission` and render 404 when it fails; UI hides controls the role can't use.
3. RLS makes cross-tenant access impossible regardless of role.

Custom roles per organization are planned; they need an `organization_id` column on `roles` and a UI. Today the five roles are global.
