# Implementation engine

The differentiator. It turns business answers into a tracking plan, code and a validation loop. Code: `apps/platform/src/modules/implementation`.

```
answers ─► classifier ─► generator ─► draft plan ─► human review ─► approve ─► publish
                                         │                                       │
                                         └─► codegen (per platform)              ▼
                                                     events ─► validator ─► status, mappings, score
```

## Design choices

- **Deterministic and explainable (generator `rules@1`).** The same answers always produce the same plan, and every event, property and user property carries the reason it was recommended. LLM assistance is planned as a *suggester* on top (naming, journey parsing, custom events), never as the source of truth and never applied without approval. See [ADR-005](adr/ADR-005-implementation-engine.md).
- **Versioned and approval-gated.** Draft → approved → published → archived. Only drafts can be edited; editing an approved or published plan copies it into a new draft version first ([tracking plan](tracking-plan.md#editing)). Publishing archives the previous version. Nothing changes production tracking without a person approving it, including events added through the management API.
- **Data, not code paths.** Business models, features, event and property libraries are catalogues; adding a model is adding data.

## 1. Questionnaire (`questions.ts`)

Six sections: business, app, monetization, journey, attribution, value. Questions are adaptive:

- `when(answers)`: shown only when relevant (billing periods only for subscriptions, user types only when there are several).
- `suggest(answers)`: pre-filled answers (the business model is suggested from the free-text description; activation and north-star candidates come from the model).
- Computed options (the "main channel" question lists only the channels chosen).
- A follow-up revealed by an answer is asked next rather than failing the submission.

Answers are stored per question (`tracking_answers`) with who answered and when.

## 2. Classifier (`classifier.ts`)

Combines the explicit model answer with keyword evidence from free text (description, problem, value, primary action, journey). Produces a primary model, secondary models and a confidence. `SUBSUMES` rules prevent double counting (delivery and marketplace subsume e-commerce, so a food delivery app doesn't get two purchase events). Food businesses are detected so `vendor_*` events become `restaurant_*`.

## 3. Generator (`generator.ts`)

Builds the plan from:

| Input | Effect |
| --- | --- |
| Primary model | Core funnel events, activation and north-star candidates |
| Secondary models | Extra events, never a second revenue event |
| Features (search, cart, subscriptions, wallet, referrals, push, …) | Feature events |
| Journey text | Phrase → event matching (`JOURNEY_PHRASES`, with model-specific substitutions) |
| Monetization + payment confirmation | One revenue event and its source (backend when a server confirms payment), refunds, renewals |
| Channels | Attribution rules with click-id parameters (gclid, fbclid, ttclid, ScCid, twclid) and UTM requirements |
| Activation / north star answers | Marked events; a custom activation event is added if not in the library |

Plus base user properties, warnings (client-only revenue, no signup but identity needed, missing currency) and a summary (classification, journey matches, revenue event).

## 4. Codegen (`codegen.ts`)

Per event: TypeScript/React Native, Kotlin, Swift, Dart and a backend `curl` with `$LEANAPP_SECRET_KEY` and `Idempotency-Key`. Required properties are commented. Snippets for SDKs that are not published are labelled "target API".

## 5. Validation (`validate.ts`)

Per event against the published plan: missing required properties, wrong types, invalid ISO 4217 currencies, negative amounts (refunds must be refund events), values outside the allowed set, properties not in the plan, conversions without `user_id`, and volatile user properties (actions sent as traits).

## 6. Mappings (`similarity.ts`)

Unplanned event names are compared with planned ones (token synonyms such as order↔purchase, sign up/signup/register, add to cart variants). Matches above 0.6 are stored as **suggested** mappings. Only an accepted mapping changes how events are counted, and accepting re-validates recent events. Mappings can also be added by hand.

Every change to a mapping is recorded as a revision in `event_mapping_history`. With the app's `mapping_history` switch on, revisions can be restored and each change also re-maps all past events in the background, not only the recent window. See [growth model](growth-model.md#mapping-history).

## 7. Implementation Score (`score.ts`)

A pure function of observed facts in one environment.

| Component | Weight | Measures |
| --- | --- | --- |
| SDK connection | 15 | Events received in the last 7 days |
| Core events | 25 | Required app events received and valid |
| Revenue events | 20 | Revenue-relevant events received and valid |
| User properties | 10 | Planned user properties observed |
| Attribution | 10 | Planned attribution parameters observed |
| Backend events | 10 | Backend-sourced events received from a server key |
| Automation readiness | 10 | Automation trigger events valid |

Components with nothing planned are excluded and the remaining weights re-normalized. The score also lists missing critical events and failing events.

## 8. Hand edits, diff and export (`editor.ts`, `plan-input.ts`, `diff.ts`)

Custom events and properties, user properties, version diffs and JSON/CSV export. Names follow the catalog's convention (snake_case, object_action, past tense) and are checked against the event library with the same similarity function as mappings. See [tracking plan](tracking-plan.md#editing).

## Limits today

- Rules only. No LLM assistance yet.
- English keyword matching for free text; Arabic answers classify through the explicit model question only.
- Templates and dependencies tables (`implementation_templates`, `implementation_dependencies`) exist but are not used yet.
