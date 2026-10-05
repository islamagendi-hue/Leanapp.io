# ADR-008: Versioned tracking plans with approval

**Status:** Accepted · 2026-10-05

## Context
Tracking plans change as products change. Validation, scores and later analytics depend on which plan was in force.

## Decision
Plans are versioned: draft → approved → published → archived. Only drafts are editable. Exactly one published version per app validates incoming events. Publishing archives the previous version, recomputes implementation status and marks removed events deprecated. Approver and publisher are recorded and audited.

## Consequences
- Every validation result is explainable by a specific version.
- Changing a plan is a deliberate act; no silent changes.
- A diff view and per-environment publishing (publish to development first) are natural extensions.
