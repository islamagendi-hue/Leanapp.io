# Testing

| Suite | Command (in `apps/platform`) | What it covers |
| --- | --- | --- |
| Unit | `npm run test:unit` | Implementation engine (plan generation per business model, revenue rules, food renaming, mappings, scoring) and the JS SDK (`sdks/javascript`: batching, identity, sessions, offline retries, backoff, 401/400/413/429 handling, queue cap and TTL, attribution) |
| Integration | `npm run test:integration` | Real Postgres. Drops and recreates the `platform` schema in `DATABASE_URL_TEST`, applies migrations, then: tenant isolation across every tenant table, RBAC enforcement, and the full first-event loop (auth → questionnaire → plan → approve → publish → ingest → dedupe → idempotent replay → process → debugger → score → mapping → key rotation and revocation), plus account flows (email verification, password reset and change, session sign-out, hash upgrades, invitation email) with emails captured from the in-memory outbox, and end-user export and deletion (shared devices, other tenants untouched, job retry) |
| Static | `npm run lint`, `npm run typecheck` | ESLint (Next config), `next typegen` + `tsc` |
| Build | `npm run build` | Production build |

Current counts: 19 platform unit tests, 21 SDK tests, 43 integration tests. All green.

## Browser run of the first-priority loop

A Playwright script (kept out of the repo for now) drove a real browser against a production build: landing → sign up → create organization → create app → questionnaire → generate plan → approve → publish → SDK page → send events with the public key → events appear in the debugger with validation badges → validation page shows the score and a `purchase → order_completed` mapping suggestion → invite a member. It found and fixed two real bugs (optional questions blocking completion, SDK protocol events listed as unplanned). Adding it to CI as an end-to-end test is the next testing step.

## Rules

- Tests that touch the database use the real schema and RLS, never mocks of Postgres.
- Every tenant table is covered by the isolation sweep automatically (it reads the catalog).
- A bug fix comes with a test that fails before the fix.
