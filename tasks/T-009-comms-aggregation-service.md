---
id: T-009
title: Comms aggregation service — in-memory (ack-then-queue webhooks, threading, extraction)
stage: test
owner_agent: designer
status: pending
depends_on: [T-001, T-007]
file_ownership:
  - "services/comms/**"
spec_refs:
  - "specs/00-shared-core-architecture.md#comms-aggregation-layer-provider-agnostic--shared"
  - "specs/00-shared-core-architecture.md#core-domain-model"
  - "specs/00-shared-core-architecture.md#async-backbone-shared"
  - "decisions/adr/ADR-001-backend-language-node-ts.md"
mock_only: false
---

## Objective

A `services/comms` service exists implementing the shared comms aggregation engine with in-memory infrastructure: webhook handlers (call, SMS, email) that ack immediately and enqueue heavy work onto an in-memory queue implementing the `packages/core` event contracts; workers that thread inbound messages onto the correct `DealerThread` by resolving the deal's provider-agnostic `identity_ref`; and offer extraction (T-007) run on each inbound message with results attached to the `Message` and rolled into the thread's `current_offer`. An in-memory store holds deals/threads/messages for now. The whole pipeline is exercisable end-to-end in tests with no external infrastructure.

## Acceptance criteria

1. Webhook handlers ack immediately; all heavy work (transcription hand-off, extraction) runs asynchronously via queued events, so a provider timeout can never drop a dealer message — cites specs/00-shared-core-architecture.md "Comms aggregation layer (provider-agnostic — shared)" ("webhooks ack immediately, all heavy work (transcription, extraction) runs on the event bus. Provider timeouts must never drop a dealer message.").
2. Inbound SMS/email follow `webhook → thread onto DealerThread → extract offer`; inbound calls follow the spec flow with consent handling left as a per-product hook (not implemented here) and transcription as a stubbed event stage — cites specs/00-shared-core-architecture.md "Comms aggregation layer (provider-agnostic — shared)" (inbound call / inbound SMS-email flows).
3. Message-to-deal routing resolves via the deal's `identity_ref` and is provider-agnostic: threading behaves identically whether the underlying number/alias was provisioned by us or connected by the user, and no provider-specific identity logic exists in the service — cites specs/00-shared-core-architecture.md "Core domain model" ("`identity_ref` is deliberately provider-agnostic ... Same threading downstream.").
4. Offer extraction runs on each inbound message's text/transcript; a parsed `Offer` is attached to the `Message` (`extracted_offer`) and rolled into the thread's `current_offer` — cites specs/00-shared-core-architecture.md "Comms aggregation layer (provider-agnostic — shared)" ("Offer extraction: ... attached to the message and rolled into the thread's `current_offer`.").
5. Queue payloads conform to the event contracts defined in `packages/core` (T-001), covering at least inbound-comms processing and offer extraction — cites specs/00-shared-core-architecture.md "Async backbone (shared)".
6. Stored messages carry the `packages/core` `Message` shape (channel, direction, body|recording_url|transcript, timestamp, extracted_offer?) on `DealerThread`s under a `Deal`; no parallel definitions — cites specs/00-shared-core-architecture.md "Core domain model" and decisions/adr/ADR-001-backend-language-node-ts.md "Decision" (no parallel type definitions).
7. Vitest tests co-located in the service drive the full pipeline (webhook in → ack → queued work → threaded message → extracted offer → current_offer updated) using the in-memory queue and store, with fixture webhook payloads and no external infrastructure — cites decisions/adr/ADR-001-backend-language-node-ts.md "Consequences" (vitest, one toolchain).

## Notes / constraints

- **In-memory on purpose.** Postgres (relational core) and S3 (recordings/dossiers) per specs/00 "Core domain model" (Store), and the managed queue (SQS/SNS or equivalent) per specs/00 "Async backbone (shared)", are wired in a later epic. Design the queue and store behind interfaces so the swap is an implementation change, not a redesign.
- Webhook handler *shape* should be provider-agnostic (a normalized inbound-event type per channel); real Twilio/SES-etc. payload translation belongs to telephony/email adapters in a later epic. Use fixture payloads in the normalized shape.
- Consent handling is explicitly per-product (specs/00 comms flow: "(consent handling per product)") — expose a hook point only; consumer transcribe-only posture (specs/01 "Consent & recording posture") and B2B relay rules (specs/02) are NOT implemented in this shared service.
- Outbound send is out of Epic 1 scope except for the interface seam: the service may define an outbound port typed against the `packages/core` telephony/email adapter contracts, but implements no origination.
- `current_offer` rollup policy (merging partial offers from T-007) is designed here; log an ADR via the lead if the merge rule requires an interpretive call beyond the spec text.
- Depends on T-001 (types, event contracts) and T-007 (extractor). Runs after those; ownership disjoint from all other tasks. Writes to the receipt layer (T-008) are a later wiring step — do not take ownership of `packages/receipt/**`.

## Log

<!-- append-only; one line per event: YYYY-MM-DD HH:MM · agent · event -->
2026-08-07 12:00 · planner · task created (Epic 1: shared spine + adapter layer, runnable)
2026-08-07 · designer · design doc published (docs/design/T-009.md); stage design → build; interfaces exposed: transport-neutral WebhookIntake (T-001 §5.2 ack-then-queue table encoded as WebhookIngestOutcome, 200 = durably enqueued incl. CommsInboundQuarantinedV1 quarantine path, enqueue failure = only 503) + CommsReadModel; ports with named swap seams (EventQueue→SQS/SNS, CommsStore→Postgres, RawPayloadStore→S3); identity routing exact-match-only over authoritative bindIdentity table, unmatched → unrouted holding (never guessed, never dropped); extraction consumer-only via @offer-extraction, partial Offers per ADR-005; deviation flagged for lead (design D4): current_offer rollup merge rule (per-field newest-message-wins accumulation, fallback wholesale-replace) is an interpretive call beyond spec text "rolled into" — needs lead resolve-and-log ADR before build merges; blast radius contained to rollup.ts
2026-08-07 · builder · build complete (services/comms/**); stage build → test; implemented exactly per docs/design/T-009.md: intake (§4.1/§5.1), consumers C1–C5 (§4.2), InMemoryQueue (D11), InMemoryCommsStore (§3.2), InMemoryRawPayloadStore (D2), rollup PRIMARY policy per-field newest-wins (§6 — D4 lead ADR still open, gates merge, blast radius rollup.ts); tsc -p services/comms clean, full root vitest suite green (no tests written per stage split); two build-time port completions flagged for lead, contained to ports.ts: CommsStore.hasProcessed (read-only ledger peek — §5.4 requires check-without-mark; markProcessed alone cannot satisfy "a retry never marks") and CommsStoreReader getDeal/getThread/getMessageByRef/listQuarantined/listUnrouted (§2.2 read model + C5 rollup timestamp need a read path absent from the §3.2 listing)
