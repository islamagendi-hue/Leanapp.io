# Environment separation

Which deployment can reach which database and secrets, how that is enforced,
and what the owner still has to set. Companion to [deployment](../deployment.md)
and [infrastructure](../infrastructure.md).

## Target

| Deployment | Vercel target | Git branch | Database | Secrets |
| --- | --- | --- | --- | --- |
| Production | Production | `main` | Production Supabase project | Production values, Production target only |
| Staging | Preview | `staging` | `leanapp-staging` (ref `stpnogsoeaofxlnighnt`) | Staging values, Preview + branch `staging` only |
| Any other branch / PR | Preview | anything else | **none** | **none** |
| Local | — | — | local Postgres (`platform_dev`) | `.env.local` |

A feature-branch preview builds and serves pages, but has no database and no
secrets. It is for looking at UI, not for testing against data. Data tests run in
CI against a throwaway Postgres service.

## Current state (checked 2026-10-09)

### Verified read-only through the Vercel and Supabase APIs

Vercel project `leanapp.io` (`prj_wwpuoANA6rPwABl83rt5O3apzZNb`, team
`growxera-architects-growth-systems-and-builds-mv`). Only names, targets and
branch scope were read; no value was decrypted.

| Variable | Target | Git branch | Type |
| --- | --- | --- | --- |
| `DATABASE_URL` | Preview | `staging` | sensitive |
| `DATABASE_SSL` | Preview | `staging` | plain |
| `CRON_SECRET` | Preview | `staging` | sensitive |
| `INTEGRATIONS_ENCRYPTION_KEY` | Preview | `staging` | sensitive |
| `ATTRIBUTION_IP_HASH_SECRET` | Preview | `staging` | sensitive |
| `PUBLIC_APP_URL` | Preview | `staging` | plain |
| `PUBLIC_API_URL` | Preview | `staging` | plain |
| `DEMO_ENABLED` | Preview | `staging` | plain |

- **Every project variable is scoped to Preview + branch `staging`.** There are
  no unscoped Preview variables, no Development variables and no Production
  variables (`hiddenProductionEnvCount: 0`).
- **So a preview of any other branch gets no `DATABASE_URL` and no secret.**
  Confirmed by the deployment list: `claude/*` branches are being built as
  Preview deployments (state READY) alongside `staging`.
- **No production exists yet**: the project has no Production deployment
  (`live: false`, every listed deployment has target Preview), and the "Lean
  App" Supabase organization (Free plan) contains only `leanapp-staging`
  (eu-central-1, Postgres 17).
- **Deployment Protection is off**: `ssoProtection` and `passwordProtection`
  are both disabled, so every preview URL, staging included, is publicly
  reachable by anyone who has or guesses the URL.
- `apps/platform/vercel.json` turns off Vercel's automatic Git deploys for
  `main` and `staging`; those deploy only through the GitHub Deploy workflow's
  deploy hook after migrations. Every other branch still auto-deploys as a
  preview.

### Not verified (needs the owner or a later check)

- Team-level **Shared Environment Variables** linked to this project (the
  project env listing may not show them). Check Team Settings → Environment
  Variables.
- Production values, production Supabase project and production domains: they
  do not exist yet.
- GitHub environment secrets (`staging`, `production`) and the `production`
  environment's required reviewers and branch restriction: not readable from here.
- Whether the Vercel ↔ Supabase integration (Marketplace) is installed; it can
  inject `POSTGRES_*`/`SUPABASE_*` variables into **all** Preview deployments.
  None are present today.

## Repository safeguard

`apps/platform/src/lib/db-guard.ts`, called from `databaseUrl()` in
`src/lib/db.ts` (the only place the app's connection pool is created):

- `VERCEL_ENV=preview` and `VERCEL_GIT_COMMIT_REF` **not** in
  `PREVIEW_DB_BRANCHES` → the database connection is refused with
  "Database access is disabled on this Preview deployment (branch …)". The
  message names the branch, never the URL.
- `PREVIEW_DB_BRANCHES`: comma-separated allow-list, default `staging`. Unset or
  blank means the default. Set it only if another long-lived preview branch needs
  a database.
- A preview without Git metadata (CLI deploy) has no branch and is refused.
- Production (`VERCEL_ENV=production`), local runs, CI, `next start` and the
  migration runner (`scripts/migrate.ts`, which runs in GitHub Actions) are not
  affected.
- Effect today: none for staging (branch `staging`), and none in practice for
  feature previews, which already have no `DATABASE_URL`. It turns a future
  scoping mistake (a `DATABASE_URL` added to "all Preview branches") into a
  refused connection instead of feature branches writing to staging.
- Limits: it is a backstop, not the control. A branch can edit this file, so it
  does not stop hostile code on a branch, and it does not hide other secrets.
  The Vercel scoping below is what actually keeps secrets out of previews.

Unit tests: `src/lib/db-guard.test.ts`.

## Owner actions in Vercel

Project `leanapp.io` → Settings.

1. **Environment Variables: keep staging scoped to the branch.** Every staging
   variable stays *Preview* with *Git branch = `staging`*. When adding a new one
   (`RESEND_API_KEY`, `EMAIL_FROM`, `STRIPE_*`, `SUPPORT_EMAIL`, …), pick
   "Preview" **and** type `staging` in the branch field. Never pick "All
   Preview branches" for a secret or a database URL.
2. **Production values: Production target only**, separately generated
   (`DATABASE_URL` of the production project, its own `CRON_SECRET`,
   `INTEGRATIONS_ENCRYPTION_KEY`, `ATTRIBUTION_IP_HASH_SECRET`, live Stripe keys).
   Never tick Production and Preview together for one value. Mark secrets
   *Sensitive*.
3. **No database integration on all previews.** If the Supabase/Neon/Postgres
   Marketplace integration is ever installed, limit it so it does not inject
   connection variables into every Preview.
4. **Deployment Protection** (Settings → Deployment Protection): turn on
   *Vercel Authentication* for **Standard Protection** (all preview URLs, and
   production deployment URLs other than the production domains). This keeps
   feature previews and staging private. For automation to staging, use the
   existing *Protection Bypass for Automation* secret (`VERCEL_BYPASS` in the
   GitHub `staging` environment, also stored in Supabase Vault by
   `db/ops/schedule.sql`). If staging must stay public for the demo, add an
   exception for the staging domain only (plan-dependent: verify which
   exception options your plan offers).
5. **Shared Environment Variables** (Team Settings): confirm none is linked to
   `leanapp.io`, or that each linked one is non-secret.
6. **Optional**: Settings → Git → *Ignored Build Step* to skip building feature
   branches entirely if previews are not needed.
7. **Optional**: set `PREVIEW_DB_BRANCHES` only if a branch other than
   `staging` needs a database (Preview target). Leaving it unset is correct.

## Owner actions elsewhere

- **Supabase**: production in its own project (never in the Growx Era
  organization); staging and production keep separate database passwords and
  roles. See [backup and restore](backup-restore.md).
- **GitHub**: environment `production` restricted to branch `main` with you as
  required reviewer; its `DATABASE_URL` differs from staging's.

## Evidence to confirm

Collect once after the changes above, and again after any env change:

1. Screenshot of Settings → Environment Variables with the *Preview* filter,
   showing every row's branch as `staging`; and with the *Production* filter
   showing production rows only (values hidden).
2. Output of the read-only listing (names/targets/branches only), e.g.
   `vercel env ls --scope growxera-architects-growth-systems-and-builds-mv`
   from `apps/platform` linked to the project, attached to the Phase 0 ticket.
3. Screenshot of Settings → Deployment Protection showing Vercel
   Authentication on for Standard Protection.
4. Open a feature-branch preview URL in a private window: it should ask for a
   Vercel login. With access, `GET /v1/health` on it returns 503 with
   `database: "unreachable"` and a config error for `DATABASE_URL`, while
   staging's returns 200 and `database: "ok"`.
5. Vercel runtime logs of that feature preview: no connection to the staging
   database host (only the "Database access is disabled" or "DATABASE_URL is
   not set" error when a database page is opened).
