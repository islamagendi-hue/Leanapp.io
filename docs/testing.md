# Testing

| Suite | Command (in `apps/platform`) | What it covers |
| --- | --- | --- |
| Unit | `npm run test:unit` | Implementation engine (plan generation per business model, revenue rules, food renaming, mappings, scoring) and the JS SDK (`sdks/javascript`: batching, identity, sessions, offline retries, backoff, 401/400/413/429 handling, queue cap and TTL, attribution) |
| Integration | `npm run test:integration` | Real Postgres. Drops and recreates the `platform` schema in `DATABASE_URL_TEST`, applies migrations, then: tenant isolation across every tenant table, RBAC enforcement, and the full first-event loop (auth → questionnaire → plan → approve → publish → ingest → dedupe → idempotent replay → process → debugger → score → mapping → key rotation and revocation), plus account flows (email verification, password reset and change, session sign-out, hash upgrades, invitation email) with emails captured from the in-memory outbox, end-user export and deletion (shared devices, other tenants untouched, job retry), scheduled cleanup (plan retention in report and enforce modes, operational purges), organization settings, usage and audit log paging, and analytics (identity stitching, canonical names, funnel windows and medians, retention cohorts, revenue per currency with refunds and de-duplication, saved cohorts as filters, user profiles and shared devices, saved reports, analytics.write / users.read and tenant isolation) |
| Static | `npm run lint`, `npm run typecheck` | ESLint (Next config), `next typegen` + `tsc` |
| Build | `npm run build` | Production build |
| End-to-end | `npm run test:e2e` | Real browser against the production build (below) |

Current counts: 22 platform unit tests, 21 SDK tests, 58 integration tests, 5 end-to-end tests. All green.

## End-to-end (browser)

`npm run test:e2e` (in `apps/platform`, after `npm run build`, with `DATABASE_URL` pointing at a migrated database) starts the production server and drives Chromium through the first-priority loop: sign up → organization → app → questionnaire → generate, approve and publish the plan → send events with the public key → they appear in the event debugger → the validation page shows a score → the event appears in analytics and a funnel. It then covers the account page, organization settings and audit log, a privacy deletion, and checks that pages carry the CSP and load without console errors. CI runs it on every PR and keeps the Playwright report when it fails.

## Rules

- Tests that touch the database use the real schema and RLS, never mocks of Postgres.
- Every tenant table is covered by the isolation sweep automatically (it reads the catalog).
- A bug fix comes with a test that fails before the fix.
