---
id: T-010
title: Spine v0.5 domain migration (packages/core) — VehicleTarget/VehicleInstance, Dealership, ratified Message
stage: design
owner_agent: designer
status: pending
depends_on: []
file_ownership:
  - "packages/core/**"
spec_refs:
  - "specs/00-shared-core-architecture.md#core-domain-model"
  - "specs/00-shared-core-architecture.md#cardinality-invariants-structurally-enforced"
  - "specs/00-shared-core-architecture.md#budget-ceiling-vs-fair-price--two-different-questions-resolved-2026-08-07"
  - "specs/00-shared-core-architecture.md#dealership-data-tenancy"
  - "specs/00-shared-core-architecture.md#flag-engine-shared"
  - "specs/00-shared-core-architecture.md#async-backbone-shared"
  - "specs/00-shared-core-architecture.md#comms-aggregation-layer-provider-agnostic--shared"
  - "specs/01-consumer-product-spec.md#consent--recording-posture-resolved-2026-08-07"
  - "decisions/OPEN-QUESTIONS.md (Q11 amended, Q12 amended, Q14, Q16, Q20, Q22)"
  - "decisions/adr/ADR-001-backend-language-node-ts.md"
  - "decisions/adr/ADR-002-flag-name-payment-packing.md"
  - "decisions/adr/ADR-005-offer-sale-price-optional.md"
mock_only: false
---

## Objective

`packages/core` encodes the **v0.5** spine rather than the v0.3/v0.4 model Epic 1 built against. `VehicleSpec` is split into `VehicleTarget` (deal-level) and `VehicleInstance` (per-thread); `Deal.resolved_vehicle` is gone; `Dealership` (global) and `DealershipContact` (account-private) exist as first-class types; `DealerThread` carries `dealership_id`, `vehicle_instance`, `working_with`, and `process_step`; `Message` is the ratified shape (channel `+note`, direction `+internal`, `author`, `call_meta?`, no `recording_url`, no `transcript`); `ValuationSnapshot` and `VehicleData` bind to a `vehicle_instance_id`; `Offer.flags` gains `above_market`; and the transcription event contracts are removed from the async backbone. This is the Phase-0 task of Epic 2 — every Half-A package task and the whole persistence/API half depends on it. Downstream packages will not compile until T-011..T-014 land; that breakage is expected and sequenced, not a defect.

## Acceptance criteria

1. `VehicleTarget` is exported with `make`, `model`, and optional `year_range`, and `VehicleSpec` no longer exists anywhere in the package — cites specs/00-shared-core-architecture.md "Core domain model" (`VehicleTarget ... make, model ... year_range?`) and decisions/OPEN-QUESTIONS.md Q11 (AMENDED) ("`VehicleSpec` is therefore split into `VehicleTarget` ... and `VehicleInstance`").
2. `VehicleInstance` is exported with a declared identity field plus `vin?`, `year`, `trim?`, `mileage?`, `condition` (`new | used | certified`), and `additions[]` — cites specs/00-shared-core-architecture.md "Core domain model" (`VehicleInstance` block, and `ValuationSnapshot ... vehicle_instance_id (→ VehicleInstance)`, which requires the instance to be addressable by key).
3. `Deal.target_vehicle` is a `VehicleTarget` and `Deal.resolved_vehicle` is removed from the type entirely — cites decisions/OPEN-QUESTIONS.md Q11 (AMENDED) ("`Deal.resolved_vehicle` is removed — VIN belongs to the instance") and specs/00-shared-core-architecture.md "Core domain model" (`Deal ... target_vehicle (VehicleTarget — make + model; IMMUTABLE once any offer attaches)`).
4. The write-once rule is representable in the types: `target_vehicle.make`/`model` are settable while `Deal.status` is `draft` and immutable once any offer is attached, and the type surface does not offer a silent-mutation path — cites specs/00-shared-core-architecture.md "Cardinality invariants (structurally enforced)" ("`target_vehicle.make`/`model` are write-once — settable while the deal is `draft`, immutable once any offer is attached").
5. `Dealership` is exported as a GLOBAL record with `id`, `name`, `state`, `city`, `zip_code` and carries no account/owner field — cites specs/00-shared-core-architecture.md "Dealership data tenancy" ("A `Dealership` record (name, state, city, zip) is shared across all accounts — one row per real dealership") and decisions/OPEN-QUESTIONS.md Q12 (AMENDED).
6. `DealershipContact` is exported as an account-PRIVATE record with `name`, `role` (`general_manager | sales_manager | finance_manager | sales_agent`), `phone?`, `email?` — cites specs/00-shared-core-architecture.md "Dealership data tenancy" ("`DealershipContact` records ... are scoped to the account that entered them and are never exposed to another account") and specs/00 "Core domain model" (`DealershipContact` block).
7. `DealerThread` carries `dealership_id`, `vehicle_instance`, `working_with`, `process_step` (`information_gather | deal_negotiation | deal_approval | financing | final_sale | pickup`), `messages[]`, `current_offer`; the Epic-1 `dealer_id` / `dealer_name` / `DealerContact` shape is replaced — cites specs/00-shared-core-architecture.md "Core domain model" (`DealerThread` block) and decisions/OPEN-QUESTIONS.md Q12.
8. `Message` matches the ratified shape: `channel` (`call | sms | email | note`), `direction` (`in | out | internal`), `author` (`dealer | buyer | concierge`), `body`, `call_meta?` (started_at, duration, party), `timestamp`, `extracted_offer?` — cites specs/00-shared-core-architecture.md "Core domain model" (`Message` — "ratified by Corban 2026-08-07") and decisions/OPEN-QUESTIONS.md Q22 (RATIFIED).
9. `Message.recording_url` and `Message.transcript` do not exist on the type — not nullable, not deprecated, absent — cites specs/01-consumer-product-spec.md "Consent & recording posture" ("There is no `recording_url` field on `Message` at all — no audio is ever captured or stored, so the field was removed rather than left null") and decisions/OPEN-QUESTIONS.md Q14.
10. `ValuationSnapshot` and `VehicleData` each bind to a `vehicle_instance_id`; neither can be constructed against a bare make/model — cites specs/00-shared-core-architecture.md "Core domain model" (`ValuationSnapshot ... ALWAYS of one specific car — never of a bare make/model`; `VehicleData ... vehicle_instance_id`).
11. `Offer.flags` and the exported flag list gain `above_market` alongside `payment_packing`, `rate_markup`, `junk_fee`, `over_walkaway`; `payment_packing` remains the canonical name — cites specs/00-shared-core-architecture.md "Flag engine (shared)" (five-flag list) and decisions/adr/ADR-002-flag-name-payment-packing.md.
12. `Offer.sale_price` remains optional and the "missing input ⇒ unevaluable, never zero" semantic is preserved unchanged by this migration — cites decisions/adr/ADR-005-offer-sale-price-optional.md "Decision".
13. The transcription event contracts (`comms.transcription.requested.v1`, `comms.transcription.completed.v1`, and their payload types) are removed from the event surface; the remaining backbone (inbound comms, offer extraction, valuation refresh, alert dispatch) is unchanged — cites specs/01-consumer-product-spec.md "Consent & recording posture" ("No ASR/transcription provider is required, so none is approved or wired"), decisions/OPEN-QUESTIONS.md Q14, and specs/00-shared-core-architecture.md "Async backbone (shared)".
14. The webhook rule is unaffected: acks are immediate and remaining heavy work runs on the bus — cites specs/00-shared-core-architecture.md "Comms aggregation layer (provider-agnostic — shared)" ("webhooks ack immediately, all heavy work ... runs on the event bus").
15. `identity_ref` stays provider-agnostic, with no provisioner field introduced by this migration — cites specs/00-shared-core-architecture.md "Core domain model" ("`identity_ref` is deliberately provider-agnostic").
16. Every v0.5 spine type is defined exactly once in this package; no parallel or compatibility-shim definitions of the old model survive — cites decisions/adr/ADR-001-backend-language-node-ts.md "Decision" ("defined once as TypeScript types in a shared package and imported everywhere — no parallel type definitions").
17. `packages/core` typechecks and its own tests pass standalone after the migration.

## Notes / constraints

- Phase 0 of Epic 2. Owns `packages/core/**` only. It must **not** touch root workspace config (`package.json`, `tsconfig.base.json`, `vitest.workspace.ts`, `package-lock.json`) — those belong to T-015.
- This is a **breaking** change by design. `packages/flag-engine`, `packages/offer-extraction`, `packages/receipt`, `packages/adapters/*`, and `services/comms` will not compile until T-011, T-012, T-013, T-014 land. Do not add shims to keep them green; the migration tasks are the fix.
- ADR-003 (npm workspaces), ADR-004 (`@deal-copilot/*` names, bare aliases) are binding and unchanged.
- `VehicleInstance` needs a declared key because the spec references it by `vehicle_instance_id` but does not spell the field in the model block. Declaring it is a mechanical consequence of the reference, not new scope — if the designer judges otherwise, escalate rather than invent an alternative addressing scheme.
- `year_range` is a **soft guide**, not a validation rule — no type-level or runtime rejection of an out-of-range year (specs/00 "Cardinality invariants" → Year drift; Q16).
- VIN is user-entered and unvalidated at launch; no decode-based validation belongs anywhere in this package (Q16, specs/01 backlog item 4).
- Do not touch protected paths: `CLAUDE.md`, `thesis.md`, `specs/**`, `.claude/**`.

## Log

<!-- append-only; one line per event: YYYY-MM-DD HH:MM · agent · event -->
2026-08-07 14:00 · planner · task created (Epic 2 Half A: v0.5 domain migration)
