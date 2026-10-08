# Messaging channels: WhatsApp and email campaigns

**Status: built (Phase 4).** Both channels are tested against local mocks. They are **not verified with the live WhatsApp API or live Resend**: the dashboard says so until a real send succeeds, and from then on shows when it did (`integrations.live_verified_at`).

- **Code:** `apps/platform/src/modules/whatsapp`, `src/modules/messaging` (`email.ts`, `email-content.ts`, `integrations.ts`, `consent.ts`).
- **Dashboard:** Engage → Integrations (credentials, templates, sending domain) and Engage → Email templates.
- **Permissions:** credentials and the domain need `integrations.manage`; email templates need `automations.manage`.

Both channels are steps in [automations](automation.md). An automation with a schedule trigger on an audience, with entry mode `once`, works as a one-off campaign.

Both use the customer's **own** accounts, with credentials stored per environment and encrypted with `INTEGRATIONS_ENCRYPTION_KEY`. LeanApp's own `RESEND_API_KEY` is used only for LeanApp's account emails (verification, invitations), never to email a customer's users.

## Who gets a message

Every automation message counts as marketing. Before a WhatsApp or email send, the person (user key) is skipped, and the step logged as `skipped`, when any of these is true:

- they're on the `marketing` suppression list, or on the list for the medium (`whatsapp` or `email`);
- their latest consent decision denies `marketing`;
- they have no valid recipient:
  - **WhatsApp:** the step's phone property (default `phone`) must hold an E.164 number. Spaces, dashes, dots, brackets and a `00` prefix are tolerated.
  - **Email:** the `email` user property must hold a valid address.

Frequency caps and quiet hours apply to both channels, as for push.

## WhatsApp (Meta WhatsApp Business Cloud API)

**Setup:**

- **Per environment:** phone number ID, WhatsApp Business Account (WABA) ID, a permanent system-user access token, and the app secret. The token and the app secret are encrypted together.
- **Webhook:** the integration has its own callback URL, `{PUBLIC_API_URL}/v1/whatsapp/webhook/{integration id}`, and a **verify token** (`lavt_…`). The verify token is shown once and only its SHA-256 is stored. "New verify token" issues another one.
- **Templates:** "Sync templates" reads `GET /{version}/{waba-id}/message_templates` (up to 20 pages) into `whatsapp_templates`, counting the `{{n}}` variables in the body and text header.

**Sending:**

- Only **approved templates** can be sent, because marketing messages outside the 24-hour customer service window must be templates. Free-form messages aren't supported.
- **Checks:**
  - when saving: the template must be synced and the step must fill every variable;
  - when activating: the template must be approved;
  - when sending: approval is checked again.
- **Request:** `POST https://graph.facebook.com/{version}/{phone-number-id}/messages` with `type: "template"`, the language code, and header/body text parameters. Parameters accept `{{user.x}}` / `{{event.x}}`.
- **Version:** the Graph API version defaults to `v23.0`; `WHATSAPP_GRAPH_VERSION` overrides it.
- **Delivery records:** each send is a `notifications` row (`channel = 'whatsapp'`) holding:
  - `provider_message_id` (the `wamid`);
  - `recipient_hash`, a SHA-256 of the environment and the number. The phone number itself is not stored.
- **Opt-out at send time:** error `131050` (the person stopped marketing messages from businesses) adds a `whatsapp` suppression with source `unsubscribe`.

**Webhook** (`/v1/whatsapp/webhook/{id}`):

- `GET`: Meta's handshake. It returns `hub.challenge` when `hub.verify_token` matches, otherwise `403`.
- `POST`: the body must carry `X-Hub-Signature-256: sha256=<hex HMAC-SHA256(app secret, raw body)>`, or the request gets `401`. Messages for another phone number on the same Meta app are ignored.
  - **Statuses** `sent` → `delivered` → `read` update the notification and set `delivered_at` / `read_at`. A late receipt never moves the status backwards. A `failed` status records the error, and `131050` suppresses the person.
  - **Inbound replies** that are exactly an opt-out keyword add a `whatsapp` suppression (source `unsubscribe`) for the person last messaged at that number. The keywords are English `STOP`, `UNSUBSCRIBE`, `CANCEL`, `END`, `QUIT`, `STOP PROMOTIONS` (also Meta's quick-reply button), and Arabic `إيقاف`, `ايقاف`, `توقف`, `إلغاء`, `الغاء`, `إلغاء الاشتراك`.

**Usage:** each send is metered as `whatsapp_messages`.

## Email campaigns (customer's Resend account)

**Sending domain:**

- Engage → Integrations → Email → Sending domain calls Resend's Domains API with the customer's key: `POST /domains`, `POST /domains/{id}/verify` and `GET /domains/{id}`.
- The page shows the DNS records Resend returns (MX/TXT for SPF, DKIM and so on, with their status) and the domain's status.
- It warns when the From address isn't on that domain.
- Removing the domain only forgets it in LeanApp; it stays in the customer's Resend account.

**Templates:**

- `email_templates` stores a name, subject and text per environment, with `{{user.x}}` / `{{event.x}}` variables.
- An email step uses either a template or inline subject and text.
- A template used by a draft, active or paused automation can't be deleted.

**Every email gets:**

- a plain-text body and a minimal HTML version. User content is escaped, `https` links become anchors, and Arabic text is set right-to-left;
- an unsubscribe link, `{PUBLIC_API_URL}/unsubscribe/{token}`. The token is random (24 bytes) and per email, and only its SHA-256 is stored, in `notifications.unsubscribe_token_hash`;
- `List-Unsubscribe: <that URL>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 2369 / RFC 8058).

**Unsubscribing:**

- `GET /unsubscribe/{token}` shows a confirmation button, so link scanners never unsubscribe anyone.
- `POST` (that button, or a mail provider's one-click request) adds an `email` suppression with source `unsubscribe`. It's idempotent, and unknown tokens get `404`.
- Suppressions with source `unsubscribe` can't be removed from the dashboard, because the person chose them.

**Usage:** each send is metered as `email_messages`.

## Channels & delivery

Engage → Channels & delivery (PR 11) shows each channel's health and what happened to the messages campaigns and flows sent in the environment. Credentials stay in Settings → Dev Ops → Channels.

- **Health:** one of
  - not connected;
  - connected, not verified: no real send has succeeded yet;
  - verified: a send to the provider's live API succeeded;
  - error: the last error from the provider.

  In-app is marked Beta: it needs no provider, but the SDKs have no in-app message UI yet.
- **Counts:** over the last 7 or 30 days: sent, delivered, opened, clicked and failed. They come from `notifications` and `in_app_messages`. Test sends are excluded. A metric the channel can't report shows "Not available" with the reason, never 0 or an estimate (`modules/messaging/metrics.ts`):

| Channel | Delivered | Opened | Clicked |
|---|---|---|---|
| Push | not available (FCM and APNs don't report delivery) | not available (no push-open tracking in the SDKs yet) | not available |
| Email | not available (Resend events aren't connected yet) | not available | not available |
| WhatsApp | delivery receipts | read receipts (people can turn these off) | not available |
| In-app | not available (the app reports showing, not fetching) | shown, reported by the app | clicked, reported by the app |

- **Campaign pages** show the same delivered, opened and clicked numbers for the campaign's channel.
- **Test send:** `sendTestMessage` sends one message to one person (by user ID) through the same path campaigns use (`modules/messaging/deliver.ts`, shared with the engine):
  - push goes to their devices;
  - email goes to their `email` property;
  - WhatsApp goes to their phone property, with an approved template that has no header variable;
  - in-app is queued for them.

  Consent and suppression are respected. The result says exactly what happened, for example "Sent to 1 of 1 device" or "Not sent: this person has no active push token". A live success marks the channel verified. Test sends need `automations.manage`, are limited to 20 an hour per environment, and are audited as `message.test_sent`.

## Local testing

On local deployments only, `WHATSAPP_API_BASE_URL` and `RESEND_API_BASE_URL` point the clients at a mock (see `test/channels.int.test.ts`). Deployments always call `graph.facebook.com` and `api.resend.com`.

## Not built

- **SMS:** left out until a provider is chosen. The Twilio Messages REST API would fit the same pattern (customer's Account SID and auth token, `StatusCallback` with `X-Twilio-Signature`), but nothing is built.
- **WhatsApp:** free-form (session) messages, media headers, buttons with dynamic URLs, and template creation from LeanApp.
- **Email:** an HTML template editor, open and click tracking, and bounce/complaint webhooks from Resend into suppressions.
