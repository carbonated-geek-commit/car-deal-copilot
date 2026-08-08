# ADR-005: `Offer.sale_price` is optional; missing inputs make flags unevaluable, never zero

- **Date:** 2026-08-07
- **Author:** chief-architect (session role)
- **Status:** accepted
- **Trigger:** T-007 design deviation D1 (docs/design/T-007.md §0, §9), escalated through builder → verifier → fixer: real dealer messages frequently quote monthly/term without stating a sale price (payment-packing behavior itself), but core `Offer` requires `sale_price`, so a truthful partial extraction cannot be typed as `Offer`.

## Decision
1. `packages/core` `Offer.sale_price` becomes **optional** (`sale_price?: MoneyCents`). Absence means *the dealer did not state a price* — a first-class, common state, not an error.
2. **Flag-engine semantics for missing inputs:** a flag whose required inputs are absent is **not emitted** and the engine must surface it as *unevaluable* (distinguishable from "evaluated, not triggered"). Missing values are never defaulted to zero. `payment_packing` remains evaluable from term alone; `over_walkaway` requires a price and is unevaluable without one.
3. T-007's fallback `ExtractedOffer` projection collapses to `export type ExtractedOffer = Offer;` (the projection is now representable in the spine directly).
4. Events (`OfferExtractionCompletedV1.offer`, `Message.extracted_offer`, `DealerThread.current_offer`) carry the (possibly partial) `Offer` unchanged — T-009 needs no special seam.

## Spec basis
- specs/00 "Comms aggregation layer" — offer extraction parses "(price, fees, APR, term, monthly)" from real dealer messages; a parse of a message that omits price must still be attachable.
- specs/00 "Flag engine" — `payment_packing` is defined by term-stretching to shrink the monthly; the spec's own flagship scenario is one where the price is being hidden.
- specs/01 — the in-office decode promise depends on partial offers reaching the war room rather than being dropped.

## Alternatives considered
- **Ratify the `ExtractedOffer` projection, keep `sale_price` required** — contains the change to one package, but leaves `Message.extracted_offer` / events / `current_offer` unable to carry a price-less offer; T-009 would need casts or a parallel type, violating ADR-001's single-definition rule in spirit.

## Consequences
- One-line core amendment (T-001 ownership) + flag-engine adjustment for undefined handling (T-002 ownership) + one-line collapse in offer-extraction (T-007 ownership) — applied by a chief-delegated integrator with this ADR as authority, logged in each task file.
- Downstream (Epic 2+): UI must render "price not stated" distinctly; the unevaluable set travels with flag results.
