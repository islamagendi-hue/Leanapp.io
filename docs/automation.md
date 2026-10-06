# Automation

**Status: built (Phase 4). Push is not yet verified against live FCM / APNs.**

- **Code:** `apps/platform/src/modules/automation`, `modules/messaging`, `modules/push`.
- **Tables:** `automations`, `automation_versions`, `automation_runs`, `notifications`, `in_app_messages`, `integrations`, `push_tokens`. The original `automation_triggers` and `automation_actions` tables are unused, because the definition is stored as JSON on `automations.definition`.
- **Permissions:** `automations.read`, `automations.manage`. Push and email credentials need `integrations.manage`.
- **Dashboard:** app → Engage → Automations and Engage → Integrations.

## Definition

- **Trigger:** one of
  - an event;
  - entering or exiting an [audience](audiences.md);
  - a schedule for an audience's members, daily or weekly at HH:MM in the organization's timezone.
- **Entry rule:** `every_time`, with optional cooldown hours, or `once` per user.
- **Steps, in order:**
  - `delay` (minutes, hours or days);
  - `branch`: an audience condition evaluated for this user. When it's false, the run exits or jumps forward to a later step;
  - `webhook`, `push`, `in_app`, `email`;
  - `update_user_property`, `send_event`.

  Text fields accept `{{user.prop}}` and `{{event.prop}}`.
- **Guardrails:**
  - A per-user frequency cap across all automations in the environment. The default is 3 messages per 24 h, and push, email and in-app messages all count.
  - Quiet hours in the organization's timezone, 22:00–08:00 by default. Push and email wait until the window ends; in-app messages aren't delayed.

## Engine

The scheduled worker (`/api/internal/process-events`) runs every 5 minutes with a budget of about 50 s. It runs these stages in order: audience recompute, trigger intake, run stepping, webhook delivery, then the purge.

- **Trigger intake:**
  - Event triggers read new events through a per-automation cursor that never skips an unprocessed event.
  - Events older than 24 h are ignored, so a new or paused automation never back-fills.
  - Audience triggers read `audience_events` after a cursor.
  - Runs are unique per (automation, user, trigger key), so a retried intake never starts a duplicate run.
  - Users with a pending deletion are excluded.
- **Loop protection:** events written by `send_event` carry `context.automation` and never trigger automations.
- **Stepping:**
  - Due runs are claimed with `for update skip locked` and a 5-minute lease, up to 50 steps per claim.
  - A failing run is retried up to 3 times, then marked `failed`.
  - Every step appends to the run's log, which is shown on the automation page.
- **Versioning:**
  - Each saved change creates a new version in `automation_versions`.
  - Runs keep the version they started on.
  - Changing the trigger of a live automation restarts its intake from now.
- **Pause and archive:** pausing stops intake and holds runs where they are; activating again resumes them. Archiving cancels runs in progress.

## Channels

| Channel | How it works | Status |
| --- | --- | --- |
| Push (FCM) | Service-account JSON → RS256 JWT → OAuth access token (cached) → FCM HTTP v1 `messages:send`. `UNREGISTERED`, `SENDER_ID_MISMATCH`, 404 and invalid-registration-token errors deactivate the token. | Built and tested against a local mock. **Not verified with live FCM.** |
| Push (APNs) | `.p8` key → ES256 provider token (cached for 50 min) → HTTP/2 to `api.push.apple.com` or the sandbox. `410`, `BadDeviceToken`, `Unregistered` and `DeviceTokenNotForTopic` deactivate the token. | Built and tested against a local HTTP/2 mock. **Not verified with live APNs.** |
| In-app | Stored in `in_app_messages`. The app polls `GET /v1/in-app` with its public key ([SDK](sdk.md#in-app-messages)). Messages expire after 72 h by default. | Built; the SDKs don't have an in-app UI yet |
| Email | Sent with the customer's own Resend key and sender address | Built; needs the customer's Resend key |
| Webhook | Signed delivery with retries ([webhooks](webhooks.md)) | Built |

Push and email credentials:

- are set per environment on Engage → Integrations;
- are stored encrypted with `INTEGRATIONS_ENCRYPTION_KEY` (AES-256-GCM, bound to the row) and never shown again.

If the key or the credentials are missing, the step is logged as failed (`not_connected`), never as sent. Each push attempt is stored in `notifications`, one row per device token. Local mocks can be used only on local deployments, through `FCM_API_BASE_URL`, `APNS_BASE_URL` and `RESEND_API_BASE_URL`.

## Consent

Every automation message counts as marketing. Before a push, in-app or email message the engine uses the privacy module (`src/modules/privacy/consent.ts`, see [API](api.md#consent-and-suppression)) and skips the step (logged as `skipped`) when the user key:

- is on the `marketing` suppression list, or on the list for the medium (`push`, `email`, `whatsapp`). Suppressions are manual, from the API, automatic from denied consent, or from an unsubscribe;
- has a latest consent decision denying `marketing`, or denying `push` when sending push.

No decision recorded means the message is allowed, so apps that don't collect consent keep working. Email also needs an `email` user property with a valid address. Webhooks, user property updates and events aren't messages and aren't checked.

## Not built yet

- Prayer-time-aware quiet hours and Ramadan scheduling.
- Holdout groups and attributing conversions to an automation.
- A per-user timezone. Quiet hours and schedules use the organization's timezone.
- An in-app message UI in the SDKs.
