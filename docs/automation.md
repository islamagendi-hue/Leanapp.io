# Automation

**Status: planned (schema only).** Tables: `automations`, `automation_triggers`, `automation_actions`, `automation_runs`, `notifications`, plus `push_tokens` which is already filled by the SDK's `registerPushToken`.

## Design

- **Triggers:** an event (from the plan, e.g. `checkout_started`), audience entry/exit, or a schedule.
- **Steps:** wait, condition (did event *X* happen since?), action. Actions: push (FCM / APNs), in-app message, email (via provider), webhook, update user property.
- **Runs:** one row per user per automation, with state and next step time; idempotent per (automation, user, trigger event) so retries never double-send.
- **Guardrails:** frequency caps per user, quiet hours in the user's time zone (prayer-time-aware windows are a MENA-specific option), Ramadan scheduling, global and per-automation kill switch, test mode against development environment only.
- **Measurement:** holdout groups and conversion attribution to the automation using plan events.

The Implementation Score's "automation readiness" component already checks that trigger events the plan marks as automation-relevant arrive valid.
