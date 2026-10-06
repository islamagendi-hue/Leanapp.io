# Audiences

**Status: planned (schema only).** Tables: `audiences`, `audience_conditions`, `audience_members`.

## Design

- **Definition:** a tree of conditions: did / did not do event *E* (with property filters) at least *n* times within a window; user property comparisons; first-seen / last-seen; attribution channel; push reachability.
- **Evaluation:** real-time for event conditions (evaluated in the processor as events arrive, state in Redis) and scheduled for time-based conditions ("hasn't ordered in 14 days"). Membership changes are written to `audience_members` with entered/exited timestamps and emitted as internal events that can trigger [automations](automation.md).
- **Uses:** automation targeting, ad-network custom audiences (hashed, consented users only), analytics breakdowns.
- **Privacy:** respect `consent_records`; exclude users with a pending deletion request.

Templates generated from the tracking plan (e.g. "added to cart, no order in 1 hour" for commerce) connect audiences to the implementation engine.
