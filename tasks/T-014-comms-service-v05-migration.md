---
id: T-014
title: Comms service v0.5 — notes-first capture, call metadata only, transcription stage removed
stage: design
owner_agent: designer
status: pending
depends_on: [T-010, T-012]
file_ownership:
  - "services/comms/**"
spec_refs:
  - "specs/00-shared-core-architecture.md#comms-aggregation-layer-provider-agnostic--shared"
  - "specs/00-shared-core-architecture.md#core-domain-model"
  - "specs/00-shared-core-architecture.md#async-backbone-shared"
  - "specs/00-shared-core-architecture.md#dealership-data-tenancy"
  - "specs/01-consumer-product-spec.md#consent--recording-posture-resolved-2026-08-07"
  - "specs/01-consumer-product-spec.md#web-surface-war-room-first"
  - "decisions/OPEN-QUESTIONS.md (Q12 amended, Q14, Q22)"
  - "decisions/adr/ADR-001-backend-language-node-ts.md"
  - "decisions/adr/ADR-006-current-offer-rollup-policy.md"
mock_only: false
---

## Objective

`services/comms` implements the v0.5 aggregation flow. The transcription stage — its consumers, its events, and the `TranscriptStub` port — is gone. An inbound call logs call metadata onto the thread and notifies the owner; the owner's typed **note** is a first-class `Message` (channel `note`, direction `internal`, author `buyer` or `concierge`) that runs through the same extractor as any SMS or email. Threads carry `dealership_id`, `vehicle_instance`, `working_with`, and `process_step`. The ports (`EventQueue`, `CommsStore`, `RawPayloadStore`, `ConsentHook`, `OutboundPort`) keep their swap-seam shape so Half B can substitute Postgres and S3 implementations without redesign; the in-memory implementations remain the test double.

## Acceptance criteria

1. The transcription stage is removed end to end: no transcription consumers, no `TranscriptStub` port, no transcript-setting store method, no transcription event subscription — cites specs/01-consumer-product-spec.md "Consent & recording posture" ("No ASR/transcription provider is required, so none is approved or wired") and decisions/OPEN-QUESTIONS.md Q14.
2. Inbound call handling follows the v0.5 flow: log call metadata (time, direction, party) on the `DealerThread` → notify owner → owner writes a note → run offer-extraction on the note — cites specs/00-shared-core-architecture.md "Comms aggregation layer (provider-agnostic — shared)" ("**Inbound call:** `provider webhook → Comms service → log call metadata (time, direction, party) on DealerThread → notify owner → owner writes a note → run offer-extraction on the note.`").
3. No audio is captured or stored on any path, and no code path can produce a recording reference — cites specs/00-shared-core-architecture.md "Comms aggregation layer" ("No audio is captured and no transcription runs") and specs/00 "Core domain model" (Store: "No audio is stored").
4. The consent hook no longer gates a transcription decision; whatever per-product seam remains does not exist to authorise recording or transcription — cites specs/01-consumer-product-spec.md "Consent & recording posture" ("Legal exposure from two-party-consent states is **avoided entirely** rather than managed — there is nothing to consent to").
5. Inbound SMS and email keep the flow `webhook → thread onto DealerThread → extract offer` — cites specs/00-shared-core-architecture.md "Comms aggregation layer" ("**Inbound SMS / email:** `webhook → thread onto DealerThread → extract offer.`").
6. A note is accepted as a first-class message (`channel: note`, `direction: internal`) and is run through the same extractor entry point as SMS and email, with the extracted offer attached to the message — cites specs/00-shared-core-architecture.md "Core domain model" (`Message.channel (call | sms | email | note)`, `direction ... internal = the buyer's/operator's own record`) and "Comms aggregation layer" ("any message text — buyer note, SMS, or email — → parsed `Offer` ... attached to the message").
7. Every stored `Message` carries an explicit `author` (`dealer | buyer | concierge`); the service never infers it — cites specs/00-shared-core-architecture.md "Core domain model" (`author ... who produced this text — never inferred`) and decisions/OPEN-QUESTIONS.md Q22.
8. Thread resolution produces/updates a `DealerThread` carrying `dealership_id` (global `Dealership` reference), `vehicle_instance`, `working_with` (account-private `DealershipContact`), and `process_step` — cites specs/00-shared-core-architecture.md "Core domain model" (`DealerThread` block) and decisions/OPEN-QUESTIONS.md Q12 (AMENDED).
9. A `DealershipContact` is never read or written outside the account that owns it, and `Dealership` records are treated as globally shared — cites specs/00-shared-core-architecture.md "Dealership data tenancy".
10. `current_offer` is rolled up by per-field newest-message-wins accumulation, unchanged — cites decisions/adr/ADR-006-current-offer-rollup-policy.md "Decision".
11. Webhooks ack immediately and all remaining heavy work runs on the event bus, so a provider timeout can never drop a dealer message — cites specs/00-shared-core-architecture.md "Comms aggregation layer" ("webhooks ack immediately, all heavy work ... runs on the event bus. Provider timeouts must never drop a dealer message.") and specs/00 "Async backbone (shared)".
12. The ports keep their shape as swap seams to Postgres, the object store, and a managed queue; no port signature encodes an in-memory assumption — cites specs/00-shared-core-architecture.md "Core domain model" (Store: "Postgres for the relational core ... object store (S3 or equiv.)") and specs/00 "Async backbone (shared)".
13. `identity_ref` routing stays provider-agnostic and exact-match; the service does not learn who provisioned an identity — cites specs/00-shared-core-architecture.md "Core domain model" ("`identity_ref` is deliberately provider-agnostic").
14. No spine type is redefined; everything domain-shaped is imported from `packages/core` — cites decisions/adr/ADR-001-backend-language-node-ts.md "Decision".
15. The end-to-end pipeline tests pass with no external infrastructure, using the in-memory implementations.

## Notes / constraints

- Depends on T-012 because the service invokes the extractor; the extractor's note-shaped entry point must land first.
- The managed queue is **not** wired in this epic — the in-memory queue stays. Only the store and raw-payload seams are filled in Half B (T-017, T-018).
- Outbound remains type-only. Origination/relay is a later epic; do not implement sending here.
- Owns `services/comms/**` only. Root workspace config belongs to T-015; the HTTP surface belongs to T-019.
- Do not touch protected paths: `CLAUDE.md`, `thesis.md`, `specs/**`, `.claude/**`.

## Log

<!-- append-only; one line per event: YYYY-MM-DD HH:MM · agent · event -->
2026-08-07 14:00 · planner · task created (Epic 2 Half A: v0.5 domain migration)
