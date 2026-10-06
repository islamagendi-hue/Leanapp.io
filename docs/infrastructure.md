# Infrastructure

## What exists today

| Piece | Choice | Status |
| --- | --- | --- |
| Code | GitHub `islamagendi-hue/Leanapp.io`: app in `apps/platform`, SDK in `sdks/` | ✓ |
| App + API runtime | Next.js 16 on Vercel (Node runtime) | Configured (`apps/platform/vercel.json`), **no Vercel project created yet** |
| Database | Postgres 15+, schema `platform` | Works on any Postgres. **Not provisioned for production yet.** |
| Background processing | `after()` after each ingestion request + Vercel Cron calling `/api/internal/process-events` | ✓ in code |
| CI | GitHub Actions: site checks, platform lint/typecheck/unit/integration (Postgres service)/build, SDK build | ✓ |
| Domain | leanapp.io | Chosen by the owner; DNS not configured |

LeanApp is a separate product from the Growx Era website and should get its own Supabase (or other Postgres) project, so its load, backups and access are independent.

## Environments

| Environment | Database | Deployment | Data |
| --- | --- | --- | --- |
| Local | Local Postgres (`platform_dev`, `platform_test`) | `npm run dev` on :3100 | Fake |
| Preview | Separate preview database (or a Supabase branch) | Vercel preview per PR | Fake |
| Production | Production database, SSL required (`DATABASE_SSL=require`) | Vercel production, from `main` only | Customer |

Inside the product, each app also has development, staging and production **data environments** with separate keys; those are a product concept and all live in the production database.

## Hostnames

| Host | Serves |
| --- | --- |
| `leanapp.io` | Marketing / landing (same app's `/` for now) |
| `app.leanapp.io` | Dashboard |
| `api.leanapp.io` | Ingestion and API |

All three can point at one Vercel project initially. Splitting ingestion into its own deployment later only changes DNS for `api.`.

## Configuration

Environment variables only, documented in `apps/platform/.env.example`: `DATABASE_URL`, `DATABASE_SSL`, `CRON_SECRET`, `PUBLIC_API_URL`, `PUBLIC_APP_URL`, `INGEST_EVENTS_PER_MINUTE`, `MANAGEMENT_API_REQUESTS_PER_MINUTE`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `INTEGRATIONS_ENCRYPTION_KEY`, `ATTRIBUTION_IP_HASH_SECRET`, `LINK_CLICKS_PER_IP_PER_MINUTE`, `LINK_CLICKS_PER_ENV_PER_MINUTE`. Production values are set in Vercel project settings, never committed.

## Scaling path

See [architecture](architecture.md#gap-between-current-and-target). Order: connection pooling (Supabase pooler / PgBouncer) → Redis for rate limits and key cache → ClickHouse for events → durable log between ingestion and processing → dedicated ingestion service. Each step has a measurable trigger.

## Data residency

Vercel and Supabase regions should be chosen close to users. For GCC customers: a Middle East region where the provider offers one (AWS has `me-central-1` in the UAE and `me-south-1` in Bahrain), otherwise an EU region. Check the managed provider's current region list before committing. Residency commitments are made per customer contract, not by default.

## Cost control

Nothing has been purchased. Everything above runs on free or existing tiers until there is traffic. Paid services are listed in the reply that accompanies each phase and wait for the owner's approval.
