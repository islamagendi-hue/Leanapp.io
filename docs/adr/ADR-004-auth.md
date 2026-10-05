# ADR-004: Authentication

**Status:** Accepted · 2026-10-05

## Context
Options: Supabase Auth, a hosted provider (Clerk, Auth0), or first-party auth. The data model needs users in the same database as tenants and RLS; organization roles are our own.

## Decision
First-party email/password auth: scrypt hashes, random session tokens stored hashed, httpOnly cookie, throttling. Schema ready for OAuth (`user_identities`) and MFA (`users.mfa_*`).

## Consequences
- No vendor dependency or per-MAU cost; full control over sessions and tenant resolution.
- We own security of the flows: email verification, password reset, OAuth and MFA must be built (planned) and reviewed.
- Switching to a hosted provider later means mapping its user id to `users.id`; tenant logic is unaffected.
