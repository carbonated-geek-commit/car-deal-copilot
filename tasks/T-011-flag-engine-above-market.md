---
id: T-011
title: Flag engine v0.5 — per-instance market-value input and the above_market flag
stage: validate
owner_agent: builder
status: in_progress
depends_on: [T-010]
file_ownership:
  - "packages/flag-engine/**"
spec_refs:
  - "specs/00-shared-core-architecture.md#flag-engine-shared"
  - "specs/00-shared-core-architecture.md#budget-ceiling-vs-fair-price--two-different-questions-resolved-2026-08-07"
  - "specs/00-shared-core-architecture.md#core-domain-model"
  - "decisions/OPEN-QUESTIONS.md (Q20)"
  - "decisions/adr/ADR-002-flag-name-payment-packing.md"
  - "decisions/adr/ADR-005-offer-sale-price-optional.md"
mock_only: false
---

## Objective

`packages/flag-engine` answers the two questions the v0.5 spec split apart. It keeps `over_walkaway` as the deal-level budget-ceiling check and gains a **per-`VehicleInstance` market-value input** plus a new `above_market` flag that fires when an offer is priced above *that specific car's* own valuation. The two flags are independently emittable, so "cheap car, bad price" and "expensive car, fair price" are both sayable. An instance with no `ValuationSnapshot` yields `above_market` as **unevaluable** — never silently clean. The engine stays pure, total, and provider-agnostic.

## Acceptance criteria

1. The engine's context type gains a market-value input carried per `VehicleInstance`, sourced from that instance's own `ValuationSnapshot` — cites specs/00-shared-core-architecture.md "Budget ceiling vs. fair price — two different questions" ("The flag engine gains a **market-value input per instance**") and decisions/OPEN-QUESTIONS.md Q20.
2. `above_market` is emitted when the offer is priced above THIS car's own valuation — cites specs/00-shared-core-architecture.md "Flag engine (shared)" ("**above_market** — the offer is priced above **this specific car's** own valuation").
3. `over_walkaway` continues to compare the offer's out-the-door total against the deal's budget ceiling (`Deal.walk_away_number`) and is not re-pointed at valuation — cites specs/00-shared-core-architecture.md "Budget ceiling vs. fair price — two different questions" (table: "Can I afford it?" → deal-level, out-the-door total, `over_walkaway`, unchanged).
4. `above_market` and `over_walkaway` are independently emittable in all four combinations, so an offer can be inside budget and above market, or over budget and fairly priced — cites specs/00-shared-core-architecture.md "Flag engine (shared)" ("Distinct from `over_walkaway`: a car can be inside your budget and still a bad price, or over budget and priced fairly") and "Budget ceiling vs. fair price" ("A cheap car can be a bad deal and an expensive one a fair deal — both must be sayable").
5. When the instance has no valuation, `above_market` is reported as **unevaluable** and appears in neither the fired set nor as a silent pass — cites specs/00-shared-core-architecture.md "Budget ceiling vs. fair price — two different questions" ("a thread with no valuation yet reports fair-price as **unevaluable** ... never as 'fine'") and decisions/adr/ADR-005-offer-sale-price-optional.md "Decision" §2.
6. When the offer states no `sale_price`, `above_market` is unevaluable rather than defaulted — cites decisions/adr/ADR-005-offer-sale-price-optional.md "Decision" §2 ("Missing values are never defaulted to zero").
7. The engine remains a pure, provider-agnostic function with no I/O, no clock, and no provider-specific inputs — cites specs/00-shared-core-architecture.md "Flag engine (shared)" ("Provider-agnostic, pure function of `Offer` + user's qualified-rate + walk-away + **the instance's market value**").
8. `payment_packing`, `rate_markup`, and `junk_fee` keep their v0.4 semantics and `payment_packing` remains the canonical name — cites specs/00-shared-core-architecture.md "Flag engine (shared)" and decisions/adr/ADR-002-flag-name-payment-packing.md.
9. The engine's flag vocabulary is imported from `packages/core`, never re-declared — cites specs/00-shared-core-architecture.md "Core domain model" (`Offer ... flags[]`) and decisions/adr/ADR-001-backend-language-node-ts.md "Decision".
10. Package typechecks and tests pass against the v0.5 spine, with fixture coverage for each of the four budget × market combinations and for the no-valuation case.

## Notes / constraints

- **Which valuation band** (`wholesale` / `trade_in` / `retail` / `private_party`) is the comparison basis for `above_market` is *not* fixed by the spec — it is threshold calibration of the same class as "junk_fee — fees above fair value". The designer must select it, and the chief must log the selection as an ADR before build proceeds (CLAUDE.md ADR duty). Do not hard-code an unlogged choice.
- Thresholds stay injectable per the Epic-1 design convention (no invented business constants inside the engine).
- Owns `packages/flag-engine/**` only. Does not touch `packages/core` (T-010) or any other package.
- Do not touch protected paths: `CLAUDE.md`, `thesis.md`, `specs/**`, `.claude/**`.

## Log

<!-- append-only; one line per event: YYYY-MM-DD HH:MM · agent · event -->
2026-08-07 14:00 · planner · task created (Epic 2 Half A: v0.5 domain migration)
2026-08-07 21:32 · designer · design complete → docs/design/T-011.md (D8–D14 logged; band per ADR-007; stage design → build)
2026-08-07 21:40 · builder · build complete → above_market + valuation/instance-id context per D8–D14; existing suite migrated off the four-flag vocabulary; tsc clean, 55/55 green (stage build → test)
2026-08-07 21:48 · tester · tests complete → test/above-market.test.ts (52 cases: §5.3 suite, §5.4 four combinations, §4.1 error paths, D10–D13, structural mandates) + test/node-shim.d.ts; 7 mutations of src/engine.ts each caught; 107/107 green, tsc clean, 0 skipped (stage test → validate)
