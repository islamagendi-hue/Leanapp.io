# Media library

Images and files for messages, shared by all environments of an app.
Code: `apps/platform/src/modules/media`, page **Engage Lab → Media library**
(`/o/{org}/apps/{app}/engage/media`), migration `0037_media_library.sql`.

## Status

| Part | State |
| --- | --- |
| Upload (several files, progress and per-file errors), browse, search, folders, tags, preview, rename, download, replace, delete | **Built** |
| Type check from file signature bytes; dimensions read from the image header | **Built** |
| Storage: Postgres driver (default) and S3-compatible driver (SigV4 over `fetch`) | **Built**; the S3 driver is tested against AWS's published SigV4 examples and a mocked `fetch`, **not against a live bucket** |
| Authorized file route and durable public links | **Built** |
| Channel rules: `validateMediaForChannel(asset, capability)` | **Built** (limits from provider docs, see below) |
| `MediaPicker` in the campaign composer (push and in-app image) | **Built**: the chosen file is saved on the campaign step (`imageAssetId`), checked, and recorded as a usage |
| Attaching the image to the FCM / APNs / in-app payload when sending | **Not built**: the senders (messaging provider adapters) call `resolveMediaForSend` for that; until then a push or in-app message goes out without its image |
| WhatsApp media headers and session media, MMS | Built: steps carry `mediaAssetId` chosen with the `MediaPicker`; the file is checked against the template's header type and the provider's declared media (`providerMediaSupport`) on save, activation and send, and sent as its durable public link |
| Provider-side upload (e.g. WhatsApp `POST /{phone-number-id}/media`) | **Interface only** (`provider-hooks.ts`); nothing calls a provider |

## Files and checks

Accepted types, decided by the file's first bytes (the browser's declared type must agree, or be generic):
JPEG, PNG, WebP (images), GIF, MP4 and 3GP (video), PDF. SVG, HTML and anything else is refused.

- Size: up to `MEDIA_MAX_UPLOAD_BYTES` (default 4 MB, under Vercel's 4.5 MB request
  body limit; capped at 9 MB because the request proxy buffers at most 10 MB).
- Images: width and height read from the JPEG frame header, PNG `IHDR`, WebP `VP8`/`VP8L`/`VP8X`
  or GIF screen descriptor; at most 8192 px a side; animated GIF/WebP is detected.
- SHA-256 checksum: uploading the same bytes again in the same app returns the existing file.
- Names keep no path; folders are `lowercase/words`; up to 20 tags.

Per-channel rules (`channel-rules.ts`):

| Channel | Allowed | Limit | Notes |
| --- | --- | --- | --- |
| Push (FCM/APNs) | JPEG, PNG | 1 MB | Android shows it with no app code. iOS shows it only if the app has a Notification Service Extension that downloads it (`mutable-content`); otherwise text only (warning unless the capability says the extension exists). Aspect far from 2:1 warns. |
| Web push | JPEG, PNG, WebP, GIF | 1 MB | Chromium shows it; Safari and Firefox show text (warning). |
| In-app | JPEG, PNG, WebP, GIF | 5 MB | Your app's in-app view must render it (warning). |
| Email | JPEG, PNG, GIF (WebP warns) | 5 MB (over 1 MB warns) | Linked from the public URL, not attached. |
| WhatsApp | Header IMAGE: JPEG/PNG 5 MB; VIDEO: MP4/3GP 16 MB; DOCUMENT: PDF 100 MB | | The header type is fixed when Meta approves the template; the file is a runtime value that must match it. TEXT/no header: no media. Without a header (session message) any of the three. |
| SMS | none | | Only when the provider declares MMS (`providerMedia`), with its own types and limits. |

A provider capability (`providerMedia: { kind, mimeTypes, maxBytes }[]`) can only narrow a channel.
Sources: FCM "send an image in the notification payload" (Android and iOS guides), Apple
`UNNotificationAttachment`, Meta WhatsApp Cloud API media reference. Re-check them when a provider changes limits.

## Where files live

`MEDIA_STORAGE_DRIVER`:

- `postgres` (default): bytes in `platform.media_objects`. Works everywhere with no other service;
  fine for a modest library. Each row records its driver, so switching later keeps old files readable.
- `s3`: any S3-compatible bucket, signed on the server with SigV4 (no SDK). Set
  `MEDIA_S3_ENDPOINT`, `MEDIA_S3_REGION`, `MEDIA_S3_BUCKET`, `MEDIA_S3_ACCESS_KEY_ID`,
  `MEDIA_S3_SECRET_ACCESS_KEY` (and `MEDIA_S3_FORCE_PATH_STYLE=false` for virtual-hosted URLs).
  Examples: Cloudflare R2 `https://<account>.r2.cloudflarestorage.com` with region `auto`; Supabase
  Storage `https://<project-ref>.supabase.co/storage/v1/s3` with the project's region and S3 access
  keys from Storage settings; AWS `https://s3.<region>.amazonaws.com`. The bucket stays **private**:
  the app reads objects and serves them. A missing variable fails the startup configuration check.

Credentials never reach the browser; the browser only sees asset ids and same-origin URLs.

## Serving

- **Authorized:** `GET /o/{org}/apps/{app}/engage/media/{id}/file` for members with `media.read`
  (previews, picker, download). `Cache-Control: private`, stored type, `nosniff`, `sandbox` CSP.
- **Public link:** `GET /m/{token}.{ext}` on `PUBLIC_API_URL`. `token` is 192 random bits. It serves
  only while the asset's public access is on and it isn't deleted (`Cache-Control: public, max-age=300`).
  Providers (WhatsApp, FCM/APNs service extensions, email clients) fetch media themselves and need
  such a stable URL, so no short-lived signed URLs are used. Public access is turned on by a member
  (with a confirmation) or automatically when a message on such a channel uses the file; it can't be
  turned off while a live message uses it. Replacing a file keeps its id and link.

## Usage tracking and cleanup

`media_usages` records which automation (flow or campaign) uses which asset on which channel; it is
rewritten each time the automation is saved (`syncAutomationMedia`, inside the same transaction), which
also checks that the asset is in the same app, not deleted, and fits the channel.

- **Delete** is soft and refused while a live (not cancelled/archived) automation uses the file.
- **Purge** (scheduled worker, `purge_media` step): removes the stored object of assets deleted more
  than 7 days ago only if no usage row points at them **and** neither their id nor their public token
  appears in any automation definition or email template of the organization. Files referenced by
  cancelled campaigns are therefore kept. The asset row stays, with `purged_at`, for the audit trail.
- Every upload, replace, edit, public-link change and delete is in the audit log (`media.*`).

## For senders (messaging adapters)

```ts
import { resolveMediaForSend } from "@/modules/media/service";
const media = await resolveMediaForSend(organizationId, appId, assetId, { channel: "whatsapp", whatsappHeader: "IMAGE" });
// media.url is the durable public link; throws MediaUnavailableError when the file is gone,
// not public, or doesn't fit the channel. There is no fallback URL.
```

`provider-hooks.ts` defines `ProviderMediaUploader` for providers that want an upload instead of a link.

## Tests

- Unit (`src/modules/media/*.test.ts`): signature sniffing and dimensions for every type, spoofed and
  unsupported files, name/folder/tag cleaning, every channel rule, SigV4 against AWS's published
  examples, the S3 driver with mocked `fetch`, storage config. **Simulated**: no bucket is contacted.
- Integration (`test/media.int.test.ts`, real Postgres with RLS): upload and dedupe, filters, RBAC per
  role, tenant isolation (another organization can't list, read, change, replace, upload into or send
  the asset), public links, campaign usage tracking and its checks, delete/unpublish refusals, replace
  in place, purge safety, and storage failure leaving nothing behind.

## Owner actions

- Nothing for the default Postgres storage.
- For object storage: create a private bucket and an access key limited to it at the provider
  (R2, Supabase Storage S3, or AWS S3), then set the `MEDIA_S3_*` variables and `MEDIA_STORAGE_DRIVER=s3`
  in Vercel (Production and Preview separately) and redeploy. Upload one file and open it in the
  library to verify; the S3 driver has not been run against a live bucket yet.
- Deleting an organization removes Postgres-stored files with it; objects in an S3 bucket under
  `org/{organization id}/` must be removed at the provider.
