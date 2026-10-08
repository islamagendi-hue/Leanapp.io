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
  - a schedule for an audience's members, daily or weekly at HH:MM in the organization's timezone;
  - `once`: one send to an audience's members at a set instant (campaigns). If the instant has passed when it's activated, it sends at once. After it fires, `trigger_cursor` is set and it never fires again, even if paused and resumed.
- **Entry rule:** `every_time`, with optional cooldown hours, or `once` per user.
- **Steps, in order:**
  - `delay` (minutes, hours or days);
  - `branch`: an audience condition evaluated for this user. When it's false, the run exits or jumps forward to a later step;
  - `webhook`, `push`, `in_app`, `email` (inline or from an email template), `whatsapp` (an approved template, see [messaging](messaging.md));
  - `update_user_property`, `send_event`;
  - `exit`: ends the run. It closes a branch's "yes" path when the "no" path follows.

  Text fields accept `{{user.prop}}` and `{{event.prop}}`.
- **Guardrails:**
  - A per-user frequency cap across all automations in the environment. The default is 3 messages per 24 h, and push, email, WhatsApp and in-app messages all count.
  - Quiet hours in the organization's timezone, 22:00–08:00 by default. Push, email and WhatsApp wait until the window ends; in-app messages aren't delayed.

- **Conversion goal** (`goal`, optional): an event and a window of 1–90 days from the trigger.
  - Reporting: a run converts when its person does the goal event (counted events only) after the trigger and within the window. The flow's page shows:
    - entered and converted;
    - conversion rate;
    - still in window;
    - median time to convert;
    - runs stopped early.
  - There is no control group, so the report shows who converted, not the lift (`goalReport` in `automation/service.ts`).
  - With `stopOnConversion` (the default), a run that converted ends before its next step, logged as "Converted: did X".
- **Exit event** (`exitEvent`, optional): a run whose person did this event since the trigger ends before its next step ("Exit event: did X").
- The goal and the exit event must differ from the trigger event. Both are checked each time a run wakes, so a run waiting on a delay ends when it wakes up.

### Flow builder

Engage → Flows draws a flow top to bottom (`components/engage/AutomationEditor.tsx`):
- Trigger, then each step as a node with its kind: Wait, Condition, Branch, Message, Action or Exit. It ends with "End of flow".
- A "+" menu on every connector inserts a step there.
- Branch nodes show where "yes" and "no" go.
- Inserting, removing and moving steps renumber branch jumps so they keep pointing at the same step (`automation/flow.ts`). A jump that no longer points forward is flagged.
- The flow's page shows the same drawing read-only (`FlowView`).

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
| Email | Sent with the customer's own Resend key, sender address and sending domain; template support, an unsubscribe link and one-click List-Unsubscribe headers ([messaging](messaging.md)) | Built and tested against a local mock; **not verified with live Resend** |
| WhatsApp | Approved template messages through the Meta WhatsApp Business Cloud API; a webhook for delivery/read receipts and STOP replies ([messaging](messaging.md)) | Built and tested against a local mock; **not verified with the live WhatsApp API** |
| Webhook | Signed delivery with retries ([webhooks](webhooks.md)) | Built |

Push and email credentials:

- are set per environment on Engage → Integrations;
- are stored encrypted with `INTEGRATIONS_ENCRYPTION_KEY` (AES-256-GCM, bound to the row) and never shown again.

If the key or the credentials are missing, the step is logged as failed (`not_connected`), never as sent. Each push attempt is stored in `notifications`, one row per device token. Local mocks can be used only on local deployments, through `FCM_API_BASE_URL`, `APNS_BASE_URL`, `RESEND_API_BASE_URL` and `WHATSAPP_API_BASE_URL`. The integrations page shows when a provider was first verified with a real send (`live_verified_at`).

## Consent

Every automation message counts as marketing. Before a push, in-app, email or WhatsApp message the engine uses the privacy module (`src/modules/privacy/consent.ts`, see [API](api.md#consent-and-suppression)) and skips the step (logged as `skipped`) when the user key:

- is on the `marketing` suppression list, or on the list for the medium (`push`, `email`, `whatsapp`). Suppressions are manual, from the API, automatic from denied consent, or from an unsubscribe;
- has a latest consent decision denying `marketing`, or denying `push` when sending push.

No decision recorded means the message is allowed, so apps that don't collect consent keep working. Email also needs an `email` user property with a valid address. Webhooks, user property updates and events aren't messages and aren't checked.

## Campaigns

Engage → Campaigns (PR 10, migration 0027). A campaign is one message to an [audience](audiences.md), built as Audience → Channel → Message → Schedule.

- **Storage:** it's an automation with `kind = 'campaign'`, a `once` or `schedule` trigger and a single message step (`modules/campaigns`). There is no second sending model: the engine sends it with the same guardrails (frequency cap, quiet hours, consent, suppression, pending deletions) and the same run logs. Campaigns don't appear under Flows, and opening one at a Flows address redirects to its campaign page.
- **Channels:** push, in-app, email (inline or a template) and WhatsApp (an approved template without a header variable).
- **Schedule:** send now, at a date and time, every day, or every week. Times are in the organization's timezone.
- **Limits:** an optional frequency cap (messages per hours, counted across all campaigns and flows) and optional quiet hours.
- **Lifecycle:** a campaign is saved as a draft. Send (or Schedule) activates it, Pause holds it, and Cancel archives it and drops messages still waiting. A one-time campaign that went out can't be edited or sent again. The audience must be active.
- **Status:** draft, scheduled, sending, sent, recurring, paused or cancelled, derived from the automation. The page shows these counts:
  - recipients: one run per person;
  - in progress;
  - sent: handed to the provider, or queued for the app for in-app;
  - failed;
  - skipped, with the reason in each recipient's log.

  Delivery, opens and clicks are not shown yet.
- **Permissions:** `automations.read` and `automations.manage`.

## Not built yet

- Prayer-time-aware quiet hours and Ramadan scheduling.
- Holdout groups and attributing conversions to an automation.
- A per-user timezone. Quiet hours and schedules use the organization's timezone.
- An in-app message UI in the SDKs.
