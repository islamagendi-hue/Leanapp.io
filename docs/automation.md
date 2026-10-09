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
  - `once`: one send to an audience's members at a set instant (campaigns). If the instant has passed when it's activated, it sends at once. After it fires, `trigger_cursor` is set and it never fires again, even if paused and resumed;
  - `inbound_message` (`channel`: `whatsapp` or `sms`, optional `keyword`): a reply received after activation, from a number LeanApp has messaged (`inbound_messages`, see [messaging](messaging.md#inbound-messages-and-flows)). With a keyword, only a reply that is exactly that word starts a run; case and surrounding spaces are ignored. Opt-out replies and replies from unknown numbers never start runs.
- **Entry rule:** `every_time`, with optional cooldown hours, or `once` per user.
- **Steps, in order:**
  - `delay` (minutes, hours or days);
  - `branch`: an audience condition evaluated for this user. When it's false, the run exits or jumps forward to a later step;
  - `webhook`, `push`, `in_app`, `email` (inline or from an email template);
  - `whatsapp`: an approved template from the chosen `provider`, `whatsapp_cloud` (Meta, the default) or `twilio`, with an optional `mediaAssetId` for a media header. See [messaging](messaging.md);
  - `whatsapp_session`: a free-form WhatsApp message (text, optional media). It is sent only within 24 hours of the person's last message to you; otherwise it is skipped;
  - `sms`: text through Twilio, up to 1,600 characters. An optional image (MMS) goes only to +1 numbers;
  - `wait_outcome`: waits until an earlier message step of the run is `delivered`, `read`, `replied` to, or `failed`, within `withinHours` (1–720, default 24) of the send. When it happens, the run continues; otherwise it exits or jumps forward, like a branch.
    - Read is reported for WhatsApp only. Replied means an inbound message from the person's number after the send.
    - The step re-checks every 10 minutes until the deadline.
    - Validation requires an earlier step whose type reports that outcome.
  - `update_user_property`, `send_event`;
  - `exit`: ends the run. It closes a branch's "yes" path when the "no" path follows.

  Text fields accept `{{user.prop}}` and `{{event.prop}}`.
- **Guardrails:**
  - A per-user frequency cap across all automations in the environment. The default is 3 messages per 24 h, and push, email, WhatsApp, SMS and in-app messages all count.
  - Quiet hours in the organization's timezone, 22:00–08:00 by default. Push, email, WhatsApp and SMS wait until the window ends; in-app messages aren't delayed.
- **Provider checks:** WhatsApp and SMS steps are checked against the connected providers (`messaging/step-checks.ts`) on save and on activation:
  - the provider is connected and has a sender;
  - the template is synced for that provider and its variable count matches;
  - a media header has a media file, and the media fits the provider.

  On save, a missing connection or unavailable media is only a warning. On activation, it is an error, and so is a template that isn't approved.

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

### Flows library

Engage → Flows → "Start from a template" (`automation/library.ts`, `components/engage/FlowLibrary.tsx`). Each template is a definition the engine already runs: event or audience-entered triggers, waits, branch conditions, push, email, in-app and WhatsApp steps, a goal and an exit event. Nothing new runs in the engine.

| Category | Template | Goal | Starts on | Channels |
| --- | --- | --- | --- | --- |
| Onboarding | Welcome series | Activation (key action, measured only) | sign-up | push, email, in-app |
| Onboarding | Onboarding nudge | Activation | sign-up | push, email |
| Onboarding | Finish identity verification | Activation (`kyc_completed`) | `kyc_started` | push, email |
| Onboarding | Feature discovery | Activation (`feature_used`) | key action | in-app, push |
| Conversion | First purchase nudge | First purchase | sign-up | push, email |
| Conversion | Browse abandonment | First purchase (exits on add to cart) | `product_viewed` | push, in-app |
| Conversion | Wishlist reminder | First purchase | `wishlist_added` | push, email |
| Conversion | Abandoned cart | Recover lost sales (exits on checkout) | add to cart | push, email |
| Conversion | Cart reminder on push and WhatsApp | Recover lost sales | add to cart | push, WhatsApp |
| Conversion | Checkout without an order | Recover lost sales | `checkout_started` | push, email |
| Subscriptions | Trial to paid (timed for 7 days) | Paid subscriptions | `trial_started` | in-app, push, email |
| Subscriptions | Paywall follow-up | Paid subscriptions | `paywall_viewed` | push |
| Subscriptions | Failed payment recovery | Recover lost sales (`subscription_renewed`) | `payment_failed` | push, email, in-app |
| Subscriptions | Expired subscription win-back | Paid subscriptions | `subscription_expired` | push, email |
| Post-purchase | Thank-you and review request | Reviews and referrals | purchase | push |
| Post-purchase | Rating after delivery | Reviews and referrals | `order_delivered` | in-app |
| Post-purchase | Second order nudge | Repeat purchases | audience: bought once in 60 days, not in the last 7 | push, in-app |
| Post-purchase | Referral ask for loyal customers | Reviews and referrals (`referral_link_shared`) | audience: 3+ purchases in 90 days | in-app, push |
| Retention | Win back inactive users (7, 14 and 30 days) | Bring users back | audience: last seen over 7 days ago | push, email |
| Retention | Re-engage lapsed buyers | Repeat purchases | audience: bought in the last year, not in 30 days | push, email |

- **Events:** each template names event slots (sign-up, purchase, …). A slot is filled with the first of its default or alias names that the environment has received in the last 90 days, else the first in the app's published tracking plan, else its first default. Defaults come from the event library, except `payment_failed`, which the library doesn't have. Each slot shows "sent by your app", "planned, not received" or "not tracked yet", and every slot can be changed before creating the flow.
- **Copy:** every message has English and Modern Standard Arabic copy (`src/i18n/ar/flows.ts`). The person picks the message language, which defaults to the dashboard's. The copy uses no `{{user.x}}` tokens, because a missing property renders as nothing.
- **What's missing:** each card lists what stops the flow from working in the environment, with a link to fix it: an event that isn't tracked (tracking plan) or hasn't arrived (event debugger), a channel that isn't connected, or no approved WhatsApp template (Settings → Dev Ops → Channels).
- **Creating:** "Use this flow" creates a draft and opens it. Nothing is sent until someone activates it. It needs `automations.manage`.
  - **Audiences:** a template that starts from an audience also creates that audience as a draft, in the same transaction. This needs `audiences.manage`. Activating the flow asks for the audience to be activated first. People already in the audience when it's activated don't enter the flow; only people who enter it later do. Inactivity and "bought before, not lately" can't be event triggers, because nothing happens when someone stops.
  - **WhatsApp:** the WhatsApp template needs an approved, synced template without a header variable, and a value for each body variable, one per line. Without one, the card can't create the flow and says why.
- **Search and filters:** by category, by goal, and by words in the name, description, channels or event names, in English or Arabic. They're a plain GET form, and creating a flow is a form that posts to a server action, so the library works without client JavaScript.
- **Left out on purpose:** birthdays (no condition can match "today is the birthday"), anniversaries and Ramadan or seasonal sends (the goal window counts from the trigger, and seasonal sends are [campaigns](#campaigns) with a date), and price-drop or back-in-stock alerts (they need a per-person event from the app's backend, which the event library doesn't define).

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
| WhatsApp | Approved template messages through the Meta WhatsApp Business Cloud API or Twilio, and free-form messages inside the 24-hour window; webhooks for delivery/read receipts, replies and STOP ([messaging](messaging.md)) | Built and tested against local mocks; **not verified with the live WhatsApp or Twilio APIs** |
| SMS | Text (MMS images only to +1 numbers) through the customer's Twilio account; a signed callback for delivery receipts, replies and STOP ([messaging](messaging.md#twilio-sms-mms-and-whatsapp)) | Built and tested against a local mock; **not verified with live Twilio** |
| Webhook | Signed delivery with retries ([webhooks](webhooks.md)) | Built |

Push and email credentials:

- are set per environment on Engage → Integrations;
- are stored encrypted with `INTEGRATIONS_ENCRYPTION_KEY` (AES-256-GCM, bound to the row) and never shown again.

If the key or the credentials are missing, the step is logged as failed (`not_connected`), never as sent. Each push attempt is stored in `notifications`, one row per device token. Local mocks can be used only on local deployments, through `FCM_API_BASE_URL`, `APNS_BASE_URL`, `RESEND_API_BASE_URL`, `WHATSAPP_API_BASE_URL`, `TWILIO_API_BASE_URL` and `TWILIO_CONTENT_API_BASE_URL`. The integrations page shows when a provider was first verified with a real send (`live_verified_at`).

## Consent

Every automation message counts as marketing. Before a push, in-app, email, WhatsApp or SMS message the engine uses the privacy module (`src/modules/privacy/consent.ts`, see [API](api.md#consent-and-suppression)) and skips the step (logged as `skipped`) when the user key:

- is on the `marketing` suppression list, or on the list for the medium (`push`, `email`, `whatsapp`, `sms`). Suppressions are manual, from the API, automatic from denied consent, or from an unsubscribe;
- has a latest consent decision denying `marketing`, or denying `push` when sending push.

No decision recorded means the message is allowed, so apps that don't collect consent keep working. Email also needs an `email` user property with a valid address. Webhooks, user property updates and events aren't messages and aren't checked.

## Campaigns

Engage → Campaigns (PR 10, migration 0027). A campaign is one message to an [audience](audiences.md), built as Audience → Channel → Message → Schedule.

- **Storage:** it's an automation with `kind = 'campaign'`, a `once` or `schedule` trigger and a single message step (`modules/campaigns`). There is no second sending model: the engine sends it with the same guardrails (frequency cap, quiet hours, consent, suppression, pending deletions) and the same run logs. Campaigns don't appear under Flows, and opening one at a Flows address redirects to its campaign page.
- **Channels:** push, in-app, email (inline or a template), WhatsApp (an approved template from Meta or Twilio, with header variables and a media header file where the template has them) and SMS (Twilio).
- **Composer:** WhatsApp and SMS campaigns get template search, preview, variable mapping, a media asset field, "Check campaign" (the activation checks plus reach) and "Send test" to one person. See [messaging](messaging.md#campaign-composer).
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
- Holdout groups and attributing conversions to an automation. A/B tests of campaign messages are not built either; product experiments are ([experiments](experiments.md)).
- A per-user timezone. Quiet hours and schedules use the organization's timezone.
- An in-app message UI in the SDKs.
