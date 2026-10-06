# Tracking plan

A tracking plan is the contract between the business and the code: which events exist, what each property means, where each event is sent from, and why.

## Structure

| Table | Holds |
| --- | --- |
| `tracking_plans` | One per app; points at the published version |
| `tracking_plan_versions` | Version number, status, generator, business model, activation and north-star events, summary (classification, warnings, journey matches), who approved and published, when |
| `tracking_events` | Name, display name, description, trigger ("fires when"), source (`mobile_sdk`, `backend`, `both`, `automatic`), priority, required, platforms, relevance flags (conversion, revenue, attribution, automation), reason, source note |
| `tracking_event_properties` | Name, type (`string`, `number`, `integer`, `boolean`, `currency`, `datetime`, `array`, `object`), required, description, allowed values, example |
| `tracking_user_properties` | Name, type, source, description, reason |
| `tracking_attribution_rules` | Channel, required parameters, click-id parameter, notes |

## Lifecycle

| Status | Who | Can edit | Validates events |
| --- | --- | --- | --- |
| draft | anyone with `implementation.edit` | yes (remove event, require/optional) | no |
| approved | `implementation.approve` | no | no |
| published | `implementation.approve` | no | **yes** |
| archived | automatic when a newer version is published | no | no |

Regenerating after changing answers creates a new draft version; the published version keeps validating until the new one is published. When a version is published, events no longer in the plan are marked `deprecated` in implementation status.

## Implementation status per event and environment

`approved` (planned, nothing received) → `received` (arrived, but no valid occurrence yet) → `validated` (at least one valid occurrence) → `deprecated` (removed from the plan). Counts of valid and invalid occurrences and the sources (app SDK, backend) are kept alongside.

## Example (food delivery, SA/AE, TikTok + Snapchat)

`app_installed` · `app_opened` · `signup_started` · `signup_completed` · `restaurant_viewed` · `menu_viewed` · `search_performed` · `product_viewed` · `product_added_to_cart` · `cart_viewed` · `checkout_started` · `order_completed` (backend, revenue, critical) · `order_delivered` (backend) · `order_cancelled` · `review_submitted` · `push_opened`, with attribution rules for `ttclid` and `ScCid` and activation = `order_completed`.

## Editing today vs planned

Built: remove event, mark required/optional, regenerate, approve, publish, map existing names. Planned: add custom events and properties in the UI, per-property edits, diff between versions, comments, export to CSV/JSON and to code-generated typed tracking functions.
