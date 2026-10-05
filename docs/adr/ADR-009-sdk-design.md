# ADR-009: SDK strategy

**Status:** Accepted · 2026-10-05

## Context
Customers need Android, iOS, React Native and Flutter. Building four SDKs at once delays the first-event loop.

## Decision
- Ship one TypeScript SDK first (`@leanapp/analytics`) covering web, Node and React Native, with no dependencies and pluggable storage.
- Define the contract (methods, wire format, queue, retry, session and idempotency rules) in [sdk.md](../sdk.md); native SDKs implement the same contract.
- Until native SDKs exist, native apps use the REST API, and the dashboard labels native snippets as target API.

## Consequences
- The first-event loop works today for React Native and server-side.
- Native-only capabilities (install referrer, SKAdNetwork, background flush) wait for native SDKs.
