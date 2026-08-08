---
id: T-012
title: Offer-extraction + receipt layer realigned to v0.5 (notes, author, no transcripts)
stage: design
owner_agent: designer
status: pending
depends_on: [T-010]
file_ownership:
  - "packages/offer-extraction/**"
  - "packages/receipt/**"
spec_refs:
  - "specs/00-shared-core-architecture.md#comms-aggregation-layer-provider-agnostic--shared"
  - "specs/00-shared-core-architecture.md#receipt-layer-trust-engine"
  - "specs/00-shared-core-architecture.md#core-domain-model"
  - "specs/01-consumer-product-spec.md#consent--recording-posture-resolved-2026-08-07"
  - "specs/01-consumer-product-spec.md#concierge-tier-consumer-only"
  - "decisions/OPEN-QUESTIONS.md (Q14, Q22)"
  - "decisions/adr/ADR-001-backend-language-node-ts.md"
  - "decisions/adr/ADR-005-offer-sale-price-optional.md"
mock_only: false
---

## Objective

`packages/offer-extraction` and `packages/receipt` compile and pass against the v0.5 spine. The extractor's input vocabulary is buyer notes, SMS, and email — the transcript-shaped entry point and its fixture framing are gone, and a typed note is processed exactly like any other message. The receipt layer's entry kinds become buyer note / SMS / email / call-metadata record, the `recording_ref` and `transcript` kinds are removed, and **every entry carries its author** so operator- or buyer-written text is never presented as the dealer's. The store contract stays structurally append-only.

## Acceptance criteria

1. The extractor is channel-agnostic over the v0.5 channel set (`call | sms | email | note`) through a single entry point, and never depends on how the text was produced — cites specs/00-shared-core-architecture.md "Comms aggregation layer (provider-agnostic — shared)" ("any message text — buyer note, SMS, or email — → parsed `Offer` ... The extractor is channel-agnostic and never depends on how the text was produced") and specs/00 "Core domain model" (`Message.channel`).
2. No transcript-specific input path, parameter, or type remains in the extractor — cites specs/01-consumer-product-spec.md "Consent & recording posture" ("No ASR/transcription provider is required, so none is approved or wired") and decisions/OPEN-QUESTIONS.md Q14.
3. The transcript fixture corpus is re-based as a **buyer-note** corpus (the buyer typing what the dealer said), preserving the parsing coverage it provided — cites specs/01-consumer-product-spec.md "Consent & recording posture" ("The buyer types what the dealer said, in their own words, and the offer extractor parses the terms out of that text").
4. The extractor's output remains the core `Offer` (price, fees, APR, term, monthly), with `sale_price` optional and partial offers first-class — cites specs/00-shared-core-architecture.md "Comms aggregation layer" ("parsed `Offer` (price, fees, APR, term, monthly)") and decisions/adr/ADR-005-offer-sale-price-optional.md "Decision".
5. Receipt entry kinds cover buyer note, SMS, email, and call-metadata record; the `recording_ref` and `transcript` kinds are removed from the type surface — cites specs/00-shared-core-architecture.md "Receipt layer (trust engine)" ("Every **buyer note, SMS, email, and call-metadata record** is **append-only, timestamped, exportable**. (No recordings or transcripts exist ...)").
6. Every receipt entry carries an `author` drawn from the ratified `Message.author` set (`dealer | buyer | concierge`) and no entry can be stored without one — cites specs/00-shared-core-architecture.md "Receipt layer (trust engine)" ("Each entry carries its **author** — buyer, concierge operator, or dealer — so self-authored evidence is never presented as if it came from the dealer") and decisions/OPEN-QUESTIONS.md Q22.
7. A call-metadata receipt entry records time, direction, and party and contains no audio pointer and no transcript text — cites specs/00-shared-core-architecture.md "Comms aggregation layer" ("log call metadata (time, direction, party) on DealerThread") and specs/00 "Core domain model" (Store: "No audio is stored").
8. The store contract remains structurally append-only: append and read only, with no update, delete, overwrite, or truncate operation on any exported type — cites specs/00-shared-core-architecture.md "Receipt layer (trust engine)" ("append-only, timestamped, exportable").
9. The dossier export structure carries the author of every entry through to the exported artifact, so a reader can distinguish dealer-authored from concierge- or buyer-authored evidence — cites specs/00-shared-core-architecture.md "Receipt layer (trust engine)" and specs/01-consumer-product-spec.md "Concierge tier" ("Operator-authored notes carry the `concierge` author label ... so nothing self-authored is ever presented as if the dealer said it").
10. Bundles remain addressed by `Deal.receipt_bundle_id` — cites specs/00-shared-core-architecture.md "Core domain model" (`Deal ... receipt_bundle_id`).
11. Neither package redefines any spine type; all shared vocabulary is imported from `packages/core` — cites decisions/adr/ADR-001-backend-language-node-ts.md "Decision".
12. Both packages typecheck and their tests pass against the v0.5 spine.

## Notes / constraints

- Owns `packages/offer-extraction/**` and `packages/receipt/**`. These two are grouped because both are pure, both are pure-consumer-of-core, and grouping keeps the migration front sequenced without an artificial dependency edge between them.
- `packages/receipt`'s dossier PDF/web-link rendering stays a stub in this epic; durable storage of a rendered dossier is T-018's object store. Do not implement rendering here.
- The extraction corpus rebase is a **renaming and reframing** exercise — the parsing behaviour that corpus proved must not regress. Keep the assertions, change the provenance.
- Do not touch protected paths: `CLAUDE.md`, `thesis.md`, `specs/**`, `.claude/**`.

## Log

<!-- append-only; one line per event: YYYY-MM-DD HH:MM · agent · event -->
2026-08-07 14:00 · planner · task created (Epic 2 Half A: v0.5 domain migration)
