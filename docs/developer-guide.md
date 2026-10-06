# Developer guide

## Run locally

```bash
cd apps/platform
npm ci
cp .env.example .env.local            # edit DATABASE_URL if needed
createdb platform_dev && createdb platform_test   # local Postgres 15+
npm run db:migrate                    # applies db/migrations to DATABASE_URL
npm run dev                           # http://localhost:3100
```

Sign up, create an organization and an app, then use **Developers → SDK & API keys → Send a test event now** and watch it in **Event debugger**.

`npm test` runs unit and integration tests (integration needs `DATABASE_URL_TEST`; its `platform` schema is dropped and recreated).

Note: this Next.js version differs from older ones (async `params`/`cookies`, `proxy` instead of middleware, generated `PageProps`/`RouteContext` types). Read `node_modules/next/dist/docs/` before using an API you haven't used here.

## Layout

```
apps/platform/
  db/migrations/          SQL migrations (0002 is the frozen first RBAC seed)
  scripts/                migrate, RBAC seed generator
  src/lib/                db (withTenant / withSystem), crypto, errors, rate limit
  src/modules/<domain>/   business logic; one folder per domain
  src/server/             session, env, API helpers for routes and pages
  src/app/                pages (dashboard), actions/ (server actions), v1/ (API), api/internal/
  src/components/         UI components
  test/                   integration tests and helpers
sdks/javascript/          @leanapp/analytics
docs/                     this documentation
```

## Rules of the codebase

- **All tenant data access goes through `tenantTx(ctx, permission, fn)`.** It checks the permission and runs `fn` as `platform_app` with RLS. Use `withSystem` only for things that are not tenant-scoped (auth, key lookup, the processor) and say why in a comment.
- **New tenant table:** add `organization_id`, composite foreign keys to parents, add it to the RLS loop in the migration. The isolation test picks it up automatically and will fail until RLS is on.
- **New permission:** add it to `PERMISSIONS` and `ROLE_PERMISSIONS`, then insert it and its role grants in a new migration (see `0010_analytics.sql`). `test/rbac.int.test.ts` fails until the database matches.
- **Migrations are forward-only.** Never edit a migration that has been applied in production; add a new one.
- **Audit** security-relevant changes with `audit(db, …)` inside the same transaction.
- **Pages and actions stay thin.** Validation and rules live in modules with tests.
- **Don't fake features.** Unbuilt sections show "Soon"; docs mark status.
- **Events from the server** use a secret key and a stable `event_id`.

## Adding to the implementation engine

- A new standard event: `catalog/events.ts` (with reason and source), properties in `catalog/properties.ts`.
- A new business model: `BUSINESS_MODELS`, a `MODELS` entry (core events, activation and north-star candidates, default features), keywords in the classifier, and a generator test.
- A journey phrase: `JOURNEY_PHRASES` (use `onlyFor` when a phrase means different things per model).
