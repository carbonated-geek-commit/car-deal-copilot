---
id: T-020
title: Deal / thread / message / offer / dealership endpoints — write-once target, mismatch rejection
stage: design
owner_agent: designer
status: pending
depends_on: [T-011, T-019]
file_ownership:
  - "services/api/src/routes/**"
  - "services/api/test/routes/**"
spec_refs:
  - "specs/00-shared-core-architecture.md#core-domain-model"
  - "specs/00-shared-core-architecture.md#cardinality-invariants-structurally-enforced"
  - "specs/00-shared-core-architecture.md#budget-ceiling-vs-fair-price--two-different-questions-resolved-2026-08-07"
  - "specs/00-shared-core-architecture.md#dealership-data-tenancy"
  - "specs/00-shared-core-architecture.md#flag-engine-shared"
  - "specs/00-shared-core-architecture.md#comms-aggregation-layer-provider-agnostic--shared"
  - "specs/01-consumer-product-spec.md#web-surface-war-room-first"
  - "decisions/OPEN-QUESTIONS.md (Q11 amended, Q12 amended, Q16, Q20, Q22)"
  - "decisions/adr/ADR-005-offer-sale-price-optional.md"
  - "decisions/adr/ADR-006-current-offer-rollup-policy.md"
mock_only: false
---

## Objective

The API's resource surface: deals, dealer threads, vehicle instances, messages, offers, dealerships, and dealership contacts, over the v0.5 spine and through T-019's account context, validation, and error envelope. Two spec rules are enforced here as API behaviour: `target_vehicle` is **write-once** (settable while the deal is `draft`, rejected once any offer is attached), and a `VehicleInstance` whose make/model does not match the deal anchor is **rejected**, identified by its VIN, offered a new-deal path, and the rejection is written to the receipt trail. Year drift is not a rejection, and VIN stays user-entered and unvalidated.

## Acceptance criteria

1. Endpoints exist for deal, dealer-thread, vehicle-instance, message, offer, dealership, and dealership-contact operations over the v0.5 spine types — cites specs/00-shared-core-architecture.md "Core domain model".
2. `target_vehicle` (make, model, optional `year_range`) is settable while the deal is `draft`; once any offer is attached to the deal, a write to make or model is rejected — cites specs/00-shared-core-architecture.md "Cardinality invariants (structurally enforced)" ("`target_vehicle.make`/`model` are write-once — settable while the deal is `draft`, immutable once any offer is attached") and decisions/OPEN-QUESTIONS.md Q11 (AMENDED).
3. Submitting a `VehicleInstance` whose make/model does not match the deal's anchor is rejected, the response identifies the offending vehicle by its VIN so the client can highlight it, and the response offers opening a new deal — cites specs/00-shared-core-architecture.md "Cardinality invariants" ("the app **rejects the entry, highlights that vehicle in red against its VIN, and offers to open a new Deal**") and specs/01-consumer-product-spec.md "Web surface (war-room-first)" W2 ("A vehicle entered against the wrong make/model is **rejected and shown in red against its VIN**, with a prompt to open a new deal").
4. Every such rejection is recorded in the deal's receipt trail as an event, so a dealership's substitution attempt leaves a mark rather than vanishing — cites specs/00-shared-core-architecture.md "Cardinality invariants" ("The rejection is a receipt-trail event") and decisions/OPEN-QUESTIONS.md Q11.
5. A vehicle instance whose year falls outside the deal's `year_range` is accepted — year drift is a soft guide, never a rejection — cites specs/00-shared-core-architecture.md "Cardinality invariants" (Year drift: "a **soft guide, not a hard rejection**") and decisions/OPEN-QUESTIONS.md Q16.
6. VIN is accepted as user-entered and unvalidated; no endpoint gates acceptance on a decode lookup — cites decisions/OPEN-QUESTIONS.md Q16 ("VIN is **user-entered and unvalidated** at launch — the buyer's own record, not a lookup key").
7. Message creation accepts `channel: note` with `direction: internal` and a required `author`, and note bodies are run through offer extraction like any other message — cites specs/00-shared-core-architecture.md "Core domain model" (`Message` block) and specs/00 "Comms aggregation layer" ("any message text — buyer note, SMS, or email — → parsed `Offer`"), plus decisions/OPEN-QUESTIONS.md Q22.
8. `author` is always supplied by the caller and never inferred by the API — cites specs/00-shared-core-architecture.md "Core domain model" (`author ... who produced this text — never inferred`).
9. Thread endpoints expose and allow updating `dealership_id`, `vehicle_instance`, `working_with`, and `process_step` across the six-step sequence — cites specs/00-shared-core-architecture.md "Core domain model" (`DealerThread` block), decisions/OPEN-QUESTIONS.md Q12, and specs/01-consumer-product-spec.md "Web surface (war-room-first)" W2 ("per-dealership **who you're working with** ... plus **process step**").
10. Dealership create/lookup writes and reads the GLOBAL record; contacts are written to and read from the account-private store, and no endpoint can return another account's contact — cites specs/00-shared-core-architecture.md "Dealership data tenancy" and decisions/OPEN-QUESTIONS.md Q12 (AMENDED).
11. Offer representations carry `flags[]` over the v0.5 five-flag set including `above_market`, alongside the set of flags that could not be evaluated — cites specs/00-shared-core-architecture.md "Flag engine (shared)" (five-flag list) and decisions/adr/ADR-005-offer-sale-price-optional.md "Decision" §2.
12. An offer on a thread whose vehicle instance has no valuation is represented as fair-price **unevaluable**, never as passing — cites specs/00-shared-core-architecture.md "Budget ceiling vs. fair price — two different questions" ("a thread with no valuation yet reports fair-price as **unevaluable** ... never as 'fine'") and decisions/OPEN-QUESTIONS.md Q20.
13. An offer with no stated sale price is representable and is not rendered as a zero price — cites decisions/adr/ADR-005-offer-sale-price-optional.md "Decision" §1.
14. A thread's `current_offer` is exposed as the accumulated per-field newest-wins rollup — cites decisions/adr/ADR-006-current-offer-rollup-policy.md "Decision".
15. `over_walkaway` (deal budget ceiling) and `above_market` (this car's own valuation) are surfaced as distinct signals, never fused into a single verdict — cites specs/00-shared-core-architecture.md "Budget ceiling vs. fair price — two different questions" (the two-question table) and specs/00 "Flag engine (shared)".
16. Every endpoint goes through T-019's account context, validation, and shared error envelope; none defines its own — cites decisions/adr/ADR-001-backend-language-node-ts.md "Decision".
17. Route tests cover the write-once rejection, the make/model mismatch rejection plus its receipt entry, the year-drift acceptance, and the unevaluable fair-price representation.

## Notes / constraints

- Owns `services/api/src/routes/**` and `services/api/test/routes/**` only. Everything else under `services/api/` belongs to T-019; this task depends on it, which is what legalises the nested ownership.
- Depends on T-011 because the flag vocabulary and the evaluated/unevaluable split it surfaces are the flag engine's output contract.
- **Cross-thread ranking is value-adjusted, not raw-price** — if any ordering or comparison is exposed by these endpoints it must rank offers against each car's own valuation (specs/00 "Budget ceiling vs. fair price", Consequences bullet 3). If the designer judges ranking to be a UI concern rather than an API one, leave it out rather than inventing a half-version.
- **Auth is E3.** Do not add roles, grants, or sessions; route handlers call through the authorization choke point T-019 declares.
- Do not touch protected paths: `CLAUDE.md`, `thesis.md`, `specs/**`, `.claude/**`.

## Log

<!-- append-only; one line per event: YYYY-MM-DD HH:MM · agent · event -->
2026-08-07 14:00 · planner · task created (Epic 2 Half B: persistence & API spine)
