# Messaging channels: WhatsApp, SMS and email

**Status: built (Phase 4, extended by migration `0036`).** WhatsApp (Meta Cloud API and Twilio), SMS (Twilio) and email (Resend) are tested against local mocks only. None of them is **verified with the live provider API**. The dashboard says so until a real send succeeds, and from then on shows when it did (`integrations.live_verified_at`). A "Check connection" that succeeds against a mock says "(local mock, not the live API)". A successful connection check never sets `live_verified_at`; only a real send does.

- **Code:**
  - `apps/platform/src/modules/messaging`: `providers/registry.ts`, `providers/adapters.ts`, `providers/media.ts`, `integrations.ts`, `deliver.ts`, `inbound.ts`, `templates.ts`, `template-store.ts`, `step-checks.ts`, `variables.ts`, `connections.ts`, `consent.ts`, `email*.ts`.
  - `src/modules/whatsapp` (Meta), `src/modules/twilio` (Twilio).
- **Dashboard:**
  - Settings → Dev Ops → Channels: credentials and "Check connection".
  - Engage → WhatsApp templates: synced templates, drafts, submit and delete.
  - Engage → Email templates.
  - Engage → Campaigns: the composer.
  - Engage → Channels & delivery.
- **Permissions:**
  - credentials, connection checks, template sync, submit and delete need `integrations.manage`;
  - drafts, email templates, campaigns and test sends need `automations.manage`.

The channels are steps in [automations](automation.md) and campaigns. Campaigns are automations with `kind = 'campaign'`, so there is one engine.

Every channel uses the customer's **own** provider account. Credentials are stored per environment and encrypted with `INTEGRATIONS_ENCRYPTION_KEY`, under AAD `integration:{id}`. LeanApp's own `RESEND_API_KEY` is used only for LeanApp's account emails (verification, invitations), never to email a customer's users.

## Channels, providers, connections and capabilities

These are kept separate:

- **Channel:** what the person receives: `email`, `sms`, `push`, `web_push`, `in_app`, `whatsapp`.
- **Provider:** who delivers it, for example Meta WhatsApp Cloud API, Twilio, Resend, FCM or APNs. One provider can serve several channels; Twilio serves SMS and WhatsApp.
- **Integration connection:** one environment's credentials for one provider, stored as a `platform.integrations` row.
- **Provider capability:** what LeanApp can do with that provider. Each capability has its own status.

`providers/registry.ts` declares every provider (pure and client-safe). Each capability has one of four statuses:

| Status | Meaning |
|---|---|
| `implemented` | LeanApp calls it through the adapter in this repo. |
| `provider_supported` | The provider's official docs document it, but LeanApp doesn't call it yet. |
| `unsupported` | The provider's docs say it doesn't exist. |
| `unverified` | It couldn't be confirmed from official docs, so it is treated as not available. |

The capabilities are: connection check, send template, send free-form (session) message, template list/sync, template create/submit, template delete, delivery status callbacks, inbound messages, opt-out handling and media. Media also has per-kind MIME types and size limits.

| Provider | Channels | Status in LeanApp |
|---|---|---|
| Meta WhatsApp Cloud API | WhatsApp | All capabilities `implemented`, with Meta's media limits: image JPEG/PNG 5 MB, video 16 MB, audio 16 MB, document 100 MB, sticker WebP 500 KB. |
| Twilio | SMS, WhatsApp | Everything `implemented` except template creation (`provider_supported`; templates are created in the Twilio Console). MMS (an image up to 5 MB) only to +1 (US/Canada) numbers. |
| Resend, FCM, APNs, LeanApp in-app | email, push, in-app | As before. |
| 360dialog, Infobip, Gupshup, WATI | WhatsApp | **Descriptors only.** Capabilities their public docs document are `provider_supported`; nothing is sendable. |
| Unifonic, respond.io | WhatsApp, SMS | **Descriptors only.** Every capability is `unverified`, because specific operations couldn't be confirmed from public docs. |

The Engage → WhatsApp templates page shows this table. Adapters (`providers/adapters.ts`) implement `send` and `verify` for `whatsapp_cloud` and `twilio`. Before calling a provider, `sendThrough` refuses any channel or capability the descriptor doesn't mark `implemented`.

## Who gets a message

Every campaign and flow message counts as marketing. Before a WhatsApp, SMS or email send, the person (user key) is skipped, and the step logged as `skipped`, when any of these is true:

- they're on the `marketing` suppression list, or on the list for the medium (`whatsapp`, `sms` or `email`);
- their latest consent decision denies `marketing`;
- they have no valid recipient:
  - **WhatsApp and SMS:** the step's phone property (default `phone`) must hold an E.164 number;
  - **Email:** the `email` user property must hold a valid address.

Frequency caps and quiet hours apply to every channel, as for push.

## WhatsApp: Meta WhatsApp Business Cloud API

**Setup and connection check:**

- **Per environment:** phone number ID, WhatsApp Business Account (WABA) ID, a permanent system-user access token, and the app secret.
- **Check connection:** calls `GET /{version}/{phone-number-id}?fields=display_phone_number,verified_name,quality_rating,code_verification_status,name_status`. It stores the number's name and quality on the integration config and audits `integration.verified`. Graph errors are explained in plain words: 190 token, 10/200/294 permissions, 100, 131047 window, 132000/132001 template, 131026, 131050, 133010.
- **Webhook:** `{PUBLIC_API_URL}/v1/whatsapp/webhook/{integration id}`, with a verify token. Subscribe it to the `messages` field.

**Templates (Engage → WhatsApp templates):**

- **Sync:** reads `GET /{waba-id}/message_templates`, with `rejected_reason` and `quality_score`.
  - It stores status, language and category exactly as Meta reports them, plus the rejection reason, quality, header format and the variable keys in send order.
  - Variables may be positional (`{{1}}`) or named (`{{first_name}}`, sent with `parameter_name`).
  - Templates Meta no longer returns are removed from the catalog.
- **Search and filter:** by name or text, provider, language, status and category. A preview shows the template text.
- **Drafts** (`message_template_drafts`):
  - Drafts live only in LeanApp and never appear as synced templates.
  - **Submit:** `POST /{waba-id}/message_templates`, with positional variables and the example values Meta reviews. The draft keeps Meta's template id; the catalog is re-synced and shows Meta's real status, normally `PENDING`.
  - **Refusals:** a refusal is stored on the draft. A submitted draft can't be edited or submitted again.
  - **Not in drafts yet:** header variables, media headers and buttons. Create those in WhatsApp Manager.
- **Delete on provider:** `DELETE /{waba-id}/message_templates?name=…&hsm_id=…`. It is refused while a draft, active or paused flow or campaign uses the template.
- **Background refresh:** the worker re-syncs environments that have templates in review (`PENDING`, `IN_APPEAL`, `RECEIVED`) or a sync older than a day. This happens at most every 6 hours per environment and provider, for up to 10 environments a tick.

**Sending:**

- **Templates:** only approved templates can be sent. Every variable is required, and the checks run when saving, activating and sending.
- **Media headers:** IMAGE, VIDEO or DOCUMENT headers need a media library asset (`mediaAssetId`), sent as a `link`. See "Media" below.
- **Free-form (session) messages:** the `whatsapp_session` flow step sends text, optionally with media and the text as caption. It sends only within **24 hours of the person's last inbound message** (`messaging_sessions`); otherwise the step is skipped with "Outside the 24-hour window". Use a template to start a conversation.
- **Delivery records:** each send is a `notifications` row with `channel = 'whatsapp'` and `provider = 'whatsapp'`, `provider_message_id` (the `wamid`) and `recipient_hash`. The phone number itself is never stored.
- **Opt-outs:** error `131050` adds a `whatsapp` suppression.

**Webhook POST** (signed with `X-Hub-Signature-256`):

- statuses update the notification;
- every inbound message is recorded in `inbound_messages`. It is deduplicated by message id, the number is stored only as a hash, and the record is linked to the person last messaged at that number;
- an inbound message opens or extends the 24-hour window;
- opt-out keywords add a `whatsapp` suppression. The keywords are English STOP, UNSUBSCRIBE, CANCEL, END, QUIT and STOP PROMOTIONS, and Arabic إيقاف, ايقاف, توقف, إلغاء, الغاء and إلغاء الاشتراك.

## Twilio: SMS, MMS and WhatsApp

**Setup** (Settings → Dev Ops → Channels → Twilio):

- **Credentials:** Account SID (`AC…`) and auth token, which is encrypted.
- **SMS sender:** a Messaging Service SID (`MG…`, preferred) or an E.164 sender number.
- **WhatsApp sender:** optional, as an E.164 number.
- **Check connection:** calls `GET /2010-04-01/Accounts/{sid}.json`. It succeeds only for an `active` account.

**Callback URL:** `{PUBLIC_API_URL}/v1/twilio/webhook/{integration id}` (POST, form-encoded).

- LeanApp sets it as the `StatusCallback` of every message.
- The owner also sets it as "A message comes in" on the Twilio number or Messaging Service, to receive replies and STOP.
- Every request must carry a valid `X-Twilio-Signature`: HMAC-SHA1 with the auth token, over the exact URL plus the sorted parameters. Otherwise the request gets `401`.
- The route answers with empty TwiML, so Twilio sends no automatic reply.

**SMS:**

- **Content:** text only, up to 1,600 characters. The composer shows the GSM-7 / UCS-2 segment count; Arabic uses UCS-2, at 70 characters per part.
- **Sending:** `POST /2010-04-01/Accounts/{sid}/Messages.json`, with `To`, `MessagingServiceSid` or `From`, `Body` and `StatusCallback`.
- **MMS:** an image is attached only through Twilio and only to +1 numbers. Elsewhere the step is skipped with "MMS goes only to US and Canadian numbers".
- **Usage:** metered as `sms_messages`.
- **Status callbacks:** `sent`, `delivered`, `undelivered` and `failed` update the notification. A late receipt never moves the status backwards. SMS has no read receipts.
- **Opt-outs:**
  - error `21610`, at send time or in a callback, adds an `sms` suppression;
  - an inbound `STOP`, Twilio's `OptOutType=STOP`, or one of the opt-out keywords above adds an `sms` suppression for the person.

**WhatsApp through Twilio:**

- **Templates:** Twilio Content templates with WhatsApp approval. "Sync from providers" reads `GET https://content.twilio.com/v1/ContentAndApprovals`. Content not submitted for WhatsApp shows as `UNSUBMITTED`.
- **Sending:** by Content SID, with `ContentVariables`. The `From` and `To` values carry the `whatsapp:` prefix.
- **Delete:** `DELETE /v1/Content/{sid}`.
- **Creation:** creating Content templates from LeanApp isn't built (`provider_supported`). Create them in the Twilio Console.

## Media

Media steps reference a media library asset by id (`mediaAssetId`). Each file is checked against the provider's declared rules (`providers/media.ts`: kind, MIME type, size) and against the template header kind.

The media library belongs to another workstream and isn't in this branch. Until it lands, `modules/messaging/media.ts#resolveMedia` reports it unavailable, with no fallback and no fake URLs:

- a step with media **fails** with "Media not attached: the media library isn't available on this server";
- saving a flow or campaign with a media file **warns**;
- activating it, or the campaign Check, is **refused** with an error.

At merge, `resolveMedia` calls the media library's `resolveMediaForSend`, and the asset id fields become its `MediaPicker`.

## Inbound messages and flows

`inbound_messages` keeps each reply from WhatsApp or SMS, whichever provider received it:

- the sender is stored as a hash;
- the record is linked to a person when LeanApp last messaged that number;
- the body is kept for 90 days.

`messaging_sessions` keeps the last inbound time per channel and sender (purged after 30 days) for the 24-hour window. Both tables are scoped by organization with RLS, and both are included in privacy deletion and export.

Flows can start from replies, with the trigger `inbound_message {channel, keyword?}`. Replies from unknown numbers and opt-out replies never start a run. Flows can also wait for a message's outcome with `wait_outcome`; see [automation](automation.md).

## Campaign composer

The existing campaign form (`components/engage/CampaignForm.tsx`) gains:

- **WhatsApp:**
  - choose the provider (only connected ones are offered);
  - search, filter by language and approved-only, then pick a synced template;
  - see its status, preview it, and map each variable to a user attribute or fixed text (every variable is required);
  - give a media asset id when the template has a media header.
- **SMS:** text with a segment counter, and an optional MMS image.
- **Check campaign:** runs the same checks as activation (`checkMessagingStep`): provider connected, sender set, template synced and approved, variable count, media fits the provider. It also reports the audience's reach, with how many people are excluded by consent or suppression on the channel.
- **Send test:** sends to one person (by user ID) through the engine's own send path (`sendStepNow`). Consent, suppression, the 24-hour window, approval and media all apply; quiet hours and the frequency cap don't. The limit is 20 an hour per environment, and each test is audited as `message.test_sent`.
- **Delivery status:** the campaign page shows delivered (and read, for WhatsApp) from provider callbacks.

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

Engage → Channels & delivery shows each channel's health and what happened to the messages campaigns and flows sent in the environment. Credentials stay in Settings → Dev Ops → Channels.

- **Health:** one of
  - not connected;
  - connected, not verified: no real send has succeeded yet;
  - verified: a send to the provider's live API succeeded;
  - error: the last error from the provider.
- **Counts:** sent, delivered, opened, clicked and failed, over the last 7 or 30 days. Test sends are excluded. A metric the channel can't report shows "Not available", never 0:

| Channel | Delivered | Opened | Clicked |
|---|---|---|---|
| Push | not available (FCM and APNs don't report delivery) | not available | not available |
| Email | not available (Resend events aren't connected yet) | not available | not available |
| WhatsApp | delivery receipts | read receipts (people can turn these off) | not available |
| SMS | Twilio delivery receipts | not available (SMS has no read receipts) | not available |
| In-app | not available | shown, reported by the app | clicked, reported by the app |

- **Test send:** sends one message to one person through the path campaigns use.
  - SMS goes through Twilio to the given phone property.
  - WhatsApp templates are chosen per provider. Templates with a media header are tested from a campaign instead.

## Simulated vs live

| What | Status |
|---|---|
| Meta Graph API calls (verify, sync, submit, delete, template and session sends) | Simulated: tested against a local mock (`test/channels.int.test.ts`, `test/messaging-providers.int.test.ts`). Not live-verified. |
| Twilio Messages, Accounts and Content API calls, callback signatures | Simulated: same tests. Not live-verified. |
| Webhook signature checks (Meta HMAC-SHA256, Twilio HMAC-SHA1) | Implemented per the providers' documented algorithms; tested with locally computed signatures. |
| 360dialog, Infobip, Gupshup, WATI, Unifonic, respond.io | Descriptors only. Nothing is called. |
| Media attachments | Blocked until the media library is merged (see "Media"). |

## Owner actions (live use)

1. Set `INTEGRATIONS_ENCRYPTION_KEY` (64 hex characters) and `PUBLIC_API_URL` on the deployment.
2. **Meta:**
   - In Meta Business, create a system user with a permanent token that has `whatsapp_business_messaging` and `whatsapp_business_management`.
   - Enter the phone number ID, WABA ID, token and app secret in Settings → Dev Ops → Channels, then press "Check connection".
   - In the Meta app's WhatsApp → Configuration, set the callback URL and verify token shown there, and subscribe to the `messages` field.
3. **Twilio:**
   - Enter the Account SID, auth token and a Messaging Service SID or sender number (and a WhatsApp sender, if used), then press "Check connection".
   - Set the shown callback URL as "A message comes in" (HTTP POST) on the number or Messaging Service.
   - For WhatsApp, register the sender in Twilio and create and approve Content templates in the Twilio Console.
4. Create templates (WhatsApp Manager, a LeanApp draft submitted for review, or the Twilio Console) and wait for approval. Then press "Sync from providers".
5. Send one real message (a test send or a campaign). Only then does the channel show "verified" with the time.

## Local testing

On local deployments only, `WHATSAPP_API_BASE_URL`, `RESEND_API_BASE_URL`, `TWILIO_API_BASE_URL` and `TWILIO_CONTENT_API_BASE_URL` point the clients at a mock (see `test/channels.int.test.ts` and `test/messaging-providers.int.test.ts`). Deployments (preview and production) always call `graph.facebook.com`, `api.resend.com`, `api.twilio.com` and `content.twilio.com`, whatever these variables say.

## Not built

- **WhatsApp:** buttons with dynamic URLs, carousel templates, header variables and media headers in LeanApp drafts, and the 360dialog / Infobip / Gupshup / WATI / Unifonic / respond.io adapters (descriptors only).
- **Twilio:** Content template creation from LeanApp, and MMS outside +1 numbers.
- **Media in messages:** the [media library](media.md) stores and checks files and gives senders a durable public URL (`resolveMediaForSend`), which WhatsApp and MMS sends use. Push and in-app campaign steps can carry an `imageAssetId` chosen in the composer; attaching it to the FCM/APNs/in-app payload at send time is not wired yet.
- **Email:** an HTML template editor, open and click tracking, and bounce/complaint webhooks from Resend into suppressions.
- **Integrations center UI:** owned by the integrations workstream. At merge it reads `providers/registry.ts`.
