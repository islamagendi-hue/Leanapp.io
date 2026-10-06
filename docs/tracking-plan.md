# Tracking plan

A tracking plan is the contract between the business and the code: which events exist, what each property means, where each event is sent from, and why.

## Structure

| Table | Holds |
| --- | --- |
| `tracking_plans` | One per app; points at the published version |
| `tracking_plan_versions` | Version number, status, generator, business model, activation and north-star events, summary (classification, warnings, journey matches), who approved and published, when, and `based_on_version_id` for hand-edited drafts |
| `tracking_events` | Name, display name, description, trigger ("fires when"), source (`mobile_sdk`, `backend`, `both`, `automatic`), priority, required, platforms, relevance flags (conversion, revenue, attribution, automation), reason, source note, `custom` (added by hand) |
| `tracking_event_properties` | Name, type (`string`, `number`, `integer`, `boolean`, `currency`, `datetime`, `array`, `object`), required, description, allowed values, example |
| `tracking_user_properties` | Name, type, source, description, reason |
| `tracking_attribution_rules` | Channel, required parameters, click-id parameter, notes |

## Lifecycle

| Status | Who | Can edit | Validates events |
| --- | --- | --- | --- |
| draft | anyone with `implementation.edit` (or a secret key with `plan:write`, adding events only) | yes | no |
| approved | `implementation.approve` | no | no |
| published | `implementation.approve` | no | **yes** |
| archived | automatic when a newer version is published | no | no |

Regenerating after changing answers creates a new draft version; the published version keeps validating until the new one is published. When a version is published, events no longer in the plan are marked `deprecated` in implementation status.

## Implementation status per event and environment

`approved` (planned, nothing received) → `received` (arrived, but no valid occurrence yet) → `validated` (at least one valid occurrence) → `deprecated` (removed from the plan). Counts of valid and invalid occurrences and the sources (app SDK, backend) are kept alongside.

## Example (food delivery, SA/AE, TikTok + Snapchat)

`app_installed` · `app_opened` · `signup_started` · `signup_completed` · `restaurant_viewed` · `menu_viewed` · `search_performed` · `product_viewed` · `product_added_to_cart` · `cart_viewed` · `checkout_started` · `order_completed` (backend, revenue, critical) · `order_delivered` (backend) · `order_cancelled` · `review_submitted` · `push_opened`, with attribution rules for `ttclid` and `ScCid` and activation = `order_completed`.

## Editing

Code: `apps/platform/src/modules/implementation/editor.ts` (database), `plan-input.ts` (input rules) and `diff.ts` (diff and export, pure). Dashboard: app → Implementation → Tracking plan.

**Edits never touch an approved or published version.** Every edit lands on the plan's working draft. When there is no draft, the newest approved or published version is copied (events, properties, user properties, attribution rules) into a new draft version that records `based_on_version_id`, and the edit applies to the copy. When the app has no plan at all, the first edit starts an empty draft with generator `manual`. The draft then goes through the same approve → publish flow; publishing archives the previous published version and re-runs the implementation recompute, so events of a newly added event name stop being *unplanned* and get validated.

| Edit | Rules |
| --- | --- |
| Add event | Name `^[a-z][a-z0-9_]{1,63}$`, no `__` or trailing `_`; SDK protocol names (`user_identified`, `user_aliased`, `push_token_registered`) are reserved. Warnings, not errors: not object_action, action not in the past tense, looks like a standard library event ("did you mean"). A standard library name starts from the library's definition and properties. Default platforms follow the source and the app's platforms, as for generated events. |
| Edit event | Display name, description, category, trigger, source, priority, required, platforms, relevance flags. Renaming is remove + add. |
| Remove event | |
| Set / remove event property | Name `^[a-z][a-z0-9_]{0,63}$`, not a top-level event field (`user_id`, `event_id`, …); type one of `string number integer boolean array object currency datetime`; required flag; description; allowed values (strings only); example. Setting an existing name replaces it. |
| Set / remove user property | Same name rule; types `string number integer boolean array datetime`; source. Names that describe an action (`cart_value`, `order_id`, `last_viewed_*`) are refused: they belong in event properties. |

Every edit and every draft creation is in the audit log (`tracking_plan.edited`, `tracking_plan.draft_created`), with the API key id when it came from the API.

## Diff

Any two versions can be compared (Tracking plan → Compare versions, `?from=&to=`; a new draft defaults to the version it came from). The diff lists added, removed and changed events; per changed event the changed fields and the added, removed and changed properties; user properties and attribution rules the same way; and plan-level changes (business model, activation and north-star events). Arrays such as platforms and allowed values compare without regard to order.

## Export

Each version downloads as JSON or CSV (Tracking plan → Export, `GET /o/{org}/apps/{app}/implementation/plan/export?version=&format=json|csv`).

- **JSON** `leanapp.tracking_plan/v1`: app, version, status, generator, business model, activation and north-star events, timestamps, events (with properties and relevance flags), user properties, attribution rules. The management API returns the same document for the published version (`GET /v1/tracking-plan`).
- **CSV**: header `kind,event_name,display_name,category,source,priority,event_required,custom,property_name,property_type,property_required,allowed_values,example,description,trigger`; one `event` row per event, one `event_property` row per property (allowed values joined with `|`), one `user_property` row per user property. Cells that a spreadsheet would run as formulas are prefixed with `'`.

## Planned

Comments on events, rename, and code-generated typed tracking functions per platform.
