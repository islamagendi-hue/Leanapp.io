# ADR-007: Keys

**Status:** Accepted · 2026-10-05

## Context
SDK keys ship inside apps and can be extracted; server keys must stay secret. Development and production data must never mix.

## Decision
- Public SDK keys `la_pk_{dev,stg,live}_…`: one or more per environment, can only ingest into that environment, stored in clear (needed for display) plus hash.
- Secret keys `la_sk_{dev,stg,live}_…`: hashed, shown once, mark events as `backend`-sourced. SDK refuses them outside server platforms.
- Rotation keeps the old key valid for a grace period so app releases can roll out; revocation is immediate; all operations audited.

## Consequences
- A leaked public key can only send events to one environment, limited by rate limits; abuse is handled by rotation.
- Environment tags in the key make misconfiguration visible.
