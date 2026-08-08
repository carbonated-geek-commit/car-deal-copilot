---
id: T-007
title: Offer extraction v1 — rule-based transcript/text → parsed Offer
stage: validate
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
2026-08-07 · tester · validation suite added (test/extract.test.ts unit suite + test/corpus.test.ts generic runner over 17 synthetic JSON fixtures in test/fixtures/{transcripts,sms,email,hostile} per design §6/D7): covers D6 money/term conventions, D5 disambiguation + precision omissions, APR/term bounds, fee span claiming, AC-3 channel-agnostic parity, AC-4 partial-offer gate, D4 totality (hostile/binary/huge input, 2s wall-clock budget), §4.3 determinism + fresh non-mutating results, §2 single-export surface (no webhook/ack/queue path exists), AC-2 type-level projection checks (D1 fallback); 52/52 pass, tsc --noEmit green, full workspace 443 pass / 1 pre-existing opt-in skip; no implementation defects found; D1 chief resolution remains the only open gate; stage test → validate
2026-08-07 · fixer · verifier finding (D1 unresolved chief gate) reproduced: core `Offer.sale_price` still required (packages/core/src/domain.ts:123), no D1 ADR in decisions/adr/ (only ADR-000..004), fallback `ExtractedOffer` in place (packages/offer-extraction/src/extract.ts:38); NOT fixable in fixer scope — both resolutions (core amendment `sale_price?: MoneyCents` + ADR, or ADR ratifying fallback) require chief authority and T-001-owned / decisions/adr/ files outside T-007 ownership; no code change made; suites re-verified green (offer-extraction 52/52, full workspace 443 pass / 1 pre-existing skip); ESCALATION STANDS: chief must resolve D1 before merge; builder collapse to `export type ExtractedOffer = Offer;` is a one-line follow-up if core amendment lands
2026-08-07 · integrator · ADR-005 applied (D1 resolved: core amendment landed, fallback collapsed to `export type ExtractedOffer = Offer;`; type-level tests updated to assert identity with @core Offer; 52/52 green, tsc green; stage remains validate)
