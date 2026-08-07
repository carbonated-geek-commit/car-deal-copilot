---
id: T-007
title: Offer extraction v1 — rule-based transcript/text → parsed Offer
stage: test
owner_agent: builder
status: in_progress
depends_on: [T-001]
file_ownership:
  - "packages/offer-extraction/**"
spec_refs:
  - "specs/00-shared-core-architecture.md#comms-aggregation-layer-provider-agnostic--shared"
  - "specs/00-shared-core-architecture.md#core-domain-model"
  - "decisions/adr/ADR-001-backend-language-node-ts.md"
mock_only: false
---

## Objective

A `packages/offer-extraction` package exists containing a rule-based v1 extractor: given a transcript, SMS text, or email body, it parses out an `Offer` (price, fees, APR, term, monthly) using the `packages/core` types, or returns none when no offer is present. Pure function of input text — no I/O, no provider knowledge — developed and verified against a checked-in fixture corpus of realistic dealer messages.

## Acceptance criteria

1. Given transcript/text/email input, the extractor produces a parsed `Offer` capturing price, fees, APR, term, monthly — cites specs/00-shared-core-architecture.md "Comms aggregation layer (provider-agnostic — shared)" ("Offer extraction: transcript/text/email → parsed `Offer` (price, fees, APR, term, monthly)").
2. The output is the `Offer` type from `packages/core` (sale_price, fees[], apr, term_months, monthly), suitable for attaching to a `Message.extracted_offer` and rolling into a thread's `current_offer`; no parallel offer type is defined — cites specs/00-shared-core-architecture.md "Core domain model" and decisions/adr/ADR-001-backend-language-node-ts.md "Decision" (no parallel type definitions).
3. The extractor is channel-agnostic: the same entry point handles call-transcript, SMS, and email text, matching the `Message.channel` set — cites specs/00-shared-core-architecture.md "Core domain model" (`Message.channel (call | sms | email)`).
4. Partial offers are supported (e.g. a text quoting only a monthly payment yields an `Offer` with the known fields populated), since extraction feeds `current_offer` rollup on the thread — cites specs/00-shared-core-architecture.md "Comms aggregation layer (provider-agnostic — shared)" ("attached to the message and rolled into the thread's `current_offer`").
5. Vitest tests co-located in the package run the extractor against a fixture corpus (transcripts, SMS, emails — with and without offers) fully offline — cites decisions/adr/ADR-001-backend-language-node-ts.md "Consequences" (vitest, one toolchain).

## Notes / constraints

- Rule-based v1 (regex/heuristics) per ADR-001 "Alternatives considered" ("extraction at launch is parseable with rules + LLM API calls from any language"). No LLM API calls in this task — an LLM-assisted extractor would be a later, separately-approved task.
- Pure library: the comms service (T-009) invokes it; this package does no threading, storage, or eventing itself.
- The `current_offer` rollup policy (how a new partial offer merges with the thread's existing one) lives with the thread logic in T-009; this package only needs to emit well-formed partial `Offer`s. Keep the seam clean.
- Depends only on T-001. Runs concurrently with T-002..T-006, T-008; ownership disjoint. T-009 depends on this task.

## Log

<!-- append-only; one line per event: YYYY-MM-DD HH:MM · agent · event -->
2026-08-07 12:00 · planner · task created (Epic 1: shared spine + adapter layer, runnable)
2026-08-07 · designer · design doc published (docs/design/T-007.md); stage design → build; deviation flagged for chief (design D1): AC-2+AC-4 partial offers require core `Offer.sale_price` to become optional — needs chief ADR + T-001-ownership amendment before T-007 build merges; fallback documented in design
2026-08-07 · builder · implemented packages/offer-extraction per design §1–§4 (extractOffer: normalize → fees/monthly/apr/term/price rules with span claiming → gate; zero deps, pure/total/deterministic, flags always []); D1 STILL OPEN: no chief ADR landed and core `Offer.sale_price` remains required, so build uses the design-sanctioned FALLBACK — `ExtractedOffer = Omit<Offer,'sale_price'> & {sale_price?}` derived from @core (no parallel type); collapses to `Offer` in one line if chief lands the core amendment — chief must resolve D1 before merge; tsc -p packages/offer-extraction --noEmit green; behavior smoke-checked against design §6 examples via temporary vitest run (removed — tests belong to tester stage); stage build → test
