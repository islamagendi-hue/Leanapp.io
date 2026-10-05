# LeanApp product requirements

## Problem

Mobile app companies in MENA and the GCC stitch together an MMP for attribution, a product analytics tool, and a messaging tool for push and in-app. Each has its own SDK, its own event names and its own idea of a user. The tracking plan lives in a spreadsheet that nobody keeps current, so revenue is counted three times in three tools and nobody trusts the numbers.

The deeper problem is implementation. Teams don't know *what* to track for their business model, where each event must come from (app or server), or whether what shipped matches what was planned.

## Product

One SDK and one event stream feeding attribution, product analytics and customer automation, with **Implementation Intelligence** as the entry point:

1. The customer answers business questions (model, revenue, journey, channels, the questions they need answered).
2. LeanApp generates a tracking plan: events, properties, user properties, attribution rules, activation and north-star events, each with the reason it exists and where it must be sent from.
3. A person reviews, edits and approves it. Plans are versioned; nothing changes production tracking silently.
4. LeanApp generates the code for every platform.
5. The live debugger and validation show what arrives, compare it with the plan and produce an Implementation Score.

## Users

| Persona | Needs |
| --- | --- |
| Founder / head of growth | Trustworthy acquisition, activation and revenue numbers; knows the business, not the SDK. |
| Mobile developer | Exact events and code to ship, fast feedback that it works. |
| Analyst | Clean, consistent event data with known semantics. |
| Marketer / CRM | Audiences and journeys on behaviour, attribution per channel (TikTok and Snapchat matter here as much as Google and Meta). |

## First priority loop (built)

Sign up → create organization → create app → answer questions → get tracking plan → approve and publish → install SDK → send event → event appears in debugger → implementation score.

This loop works end to end today and is covered by integration tests and a browser run (see [testing](testing.md)).

## Requirements by module

| Module | Requirement | Status |
| --- | --- | --- |
| Accounts | Email/password sign-up, sessions, organizations, invitations, five roles | Built. OAuth, MFA, email delivery planned. |
| Apps | Apps with platforms, three isolated environments each (development, staging, production) | Built |
| Keys | Public SDK keys per environment, secret server keys, rotation with grace period, revocation | Built |
| Ingestion | Batched, idempotent REST ingestion with limits, rate limits, clock-skew correction | Built (Postgres store; ClickHouse planned) |
| Implementation | Questionnaire, plan generation, versioning, approval, codegen, validation, mappings, score | Built (rules engine; LLM assistance planned) |
| Debugger | Live event feed with payload and validation | Built |
| SDK | JavaScript/TypeScript/React Native SDK with offline queue | Built. Android, iOS, Flutter SDKs planned. |
| Attribution | Touchpoints, click ids, last-touch and windowed attribution, ad network postbacks | Click ids captured; engine planned |
| Analytics | Event explorer, funnels, retention, cohorts, revenue | Events, funnels, retention built; cohorts and revenue planned |
| Audiences | Behavioural and property segments, live membership | Schema only |
| Automation | Triggered push / in-app / webhook journeys | Schema only |
| Billing | Plans, metered usage (events, MTUs), invoices | Plans and usage metering built; payment provider planned |
| Privacy | Consent, export and deletion requests | Export and deletion built; consent planned |

## Non-functional requirements

- Tenant isolation enforced in the database, not just the application ([multi-tenancy](multi-tenancy.md)).
- Production and development data never mix: separate environments, separate keys, keys tagged `dev`/`stg`/`live`.
- No server secrets in SDKs; secret keys are shown once and stored hashed.
- Ingestion is idempotent end to end: per-event `event_id` and per-request `Idempotency-Key`.
- Arabic-first products: RTL-ready UI, Arabic text in properties, local currencies (SAR, AED, KWD, QAR, BHD, OMR, EGP, JOD).
- Data residency: EU/GCC-region hosting is a target before enterprise sales (see [infrastructure](infrastructure.md)).

## Out of scope for now

Web analytics as a product, server-side tag management, a data warehouse product, and fraud detection beyond basic click-id hygiene.
