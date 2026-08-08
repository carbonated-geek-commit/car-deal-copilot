# ADR-006: `current_offer` rollup is per-field newest-message-wins accumulation

- **Date:** 2026-08-07
- **Author:** chief-architect (session role)
- **Status:** accepted
- **Trigger:** T-009 design deviation D4 (docs/design/T-009.md §0, §6, §10): specs/00 says extracted offers are "rolled into the thread's `current_offer`" without defining the merge rule. The builder implemented per-field newest-message-wins accumulation; the verifier held validation pending a ratifying ADR.

## Decision
`DealerThread.current_offer` is computed by **per-field newest-message-wins accumulation**: each newly extracted (possibly partial, per ADR-005) `Offer` overwrites only the fields it states; fields it does not state retain the most recent previously-stated value. The "current offer on the table" is the union of the dealer's latest stated terms.

## Spec basis
- specs/00 "Comms aggregation layer" — "Offer extraction: … parsed `Offer` … attached to the message and rolled into the thread's `current_offer`" (merge rule left open; this ADR closes it).
- ADR-005 — partial offers are first-class; wholesale replacement would erase previously-stated terms every time a dealer texts only a monthly, gutting the flag engine's inputs mid-negotiation.

## Alternatives considered
- **Wholesale replace (last extraction wins entirely)** — simpler, but a dealer texting "I can do $410/mo" would wipe the known sale price and term, making `over_walkaway`/`payment_packing` unevaluable exactly when the packing behavior is happening.

## Consequences
- No T-009 code change — the primary policy as built is ratified.
- Known limitation, accepted for Epic 1: accumulation can blend terms from distinct offer contexts (a new price quoted against a different term). Message-level `extracted_offer` preserves exact per-message ground truth, and the receipt trail is unaffected. Offer-session segmentation is an Epic-2 concern; revisiting it requires a superseding ADR, not a quiet rollup change.
