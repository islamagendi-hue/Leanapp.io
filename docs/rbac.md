# Roles and permissions

Defined once in `apps/platform/src/modules/rbac/permissions.ts`. The SQL seed (`db/migrations/0002_rbac_seed.sql`) was generated from it with `npm run db:seed-rbac`. Migrations that are already applied never change, so permissions added later are inserted by their own migration (`analytics.write` in `0010_analytics.sql`; Viewer in `0021_viewer_role.sql`, with `audiences.read` from `0024` and `attribution.read` / `deep_links.read` from `0033_viewer_attribution.sql`; `media.read` / `media.manage` from `0037_media_library.sql`); an integration test (`test/rbac.int.test.ts`) checks the migrated database matches `permissions.ts` for every role.

## Roles

| Role | Rank | For |
| --- | --- | --- |
| Owner | 100 | Everything, including billing and deleting the organization. At least one per organization. |
| Admin | 80 | Everything except billing changes and deleting the organization. |
| Developer | 50 | Apps, environments, keys, events and debugger, implementation (edit, approve, mappings), integrations, webhooks. |
| Analyst | 30 | Read access to events, analytics, users, attribution, audiences. |
| Marketer | 30 | Analytics, users, attribution (manage), audiences and automations (manage). |
| Viewer | 10 | Read-only: analytics, activation, acquisition and attribution (including ad spend and CAC & LTV), audiences, user profiles, and the attribution and deep link setup pages. Changes nothing; no keys, members, events debugger or billing. The public demo signs visitors in as a Viewer. |

A member can assign roles up to their own rank and can only manage members of a lower rank.

## Permission matrix

| Permission | Owner | Admin | Developer | Analyst | Marketer | Viewer |
| --- | :-: | :-: | :-: | :-: | :-: | :-: |
| organization.read | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| organization.update | ✓ | ✓ | | | | |
| organization.delete | ✓ | | | | | |
| members.read | ✓ | ✓ | ✓ | ✓ | ✓ | |
| members.invite / update_role / remove | ✓ | ✓ | | | | |
| billing.read | ✓ | ✓ | | | | |
| billing.manage | ✓ | | | | | |
| apps.read | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| apps.create / apps.update | ✓ | ✓ | ✓ | | | |
| apps.delete | ✓ | ✓ | | | | |
| credentials.read / manage | ✓ | ✓ | ✓ | | | |
| events.read | ✓ | ✓ | ✓ | ✓ | | |
| implementation.read | ✓ | ✓ | ✓ | ✓ | ✓ | |
| implementation.edit / approve / mapping | ✓ | ✓ | ✓ | | | |
| analytics.read | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| analytics.write (save reports) | ✓ | ✓ | | ✓ | ✓ | |
| growth.read | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| growth.write | ✓ | ✓ | ✓ | | | |
| users.read | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| attribution.read | ✓ | ✓ | | ✓ | ✓ | ✓ |
| attribution.manage | ✓ | ✓ | | | ✓ | |
| deep_links.read | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| deep_links.manage (link domains, iOS / Android app association) | ✓ | ✓ | ✓ | | | |
| audiences.read | ✓ | ✓ | | ✓ | ✓ | ✓ |
| audiences.manage | ✓ | ✓ | | ✓ | ✓ | |
| automations.read / manage (also experiments: read to see results, manage to create, start and stop) | ✓ | ✓ | | | ✓ | |
| integrations.read | ✓ | ✓ | ✓ | | ✓ | |
| integrations.manage, webhooks.manage | ✓ | ✓ | ✓ | | | |
| privacy.manage, audit.read | ✓ | ✓ | | | | |
| media.read / manage (media library: browse and view; upload, replace, publish a link, delete) | ✓ | ✓ | ✓ | | ✓ | |

## Enforcement

1. `tenantTx(ctx, permission, fn)` throws `ForbiddenError` before opening the transaction.
2. Pages call `requirePermission` and render 404 when it fails; UI hides controls the role can't use.
3. RLS makes cross-tenant access impossible regardless of role.

Custom roles per organization are planned; they need an `organization_id` column on `roles` and a UI. Today the six roles are global.
