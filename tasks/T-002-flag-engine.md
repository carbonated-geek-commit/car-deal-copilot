---
id: T-002
title: Flag engine — pure function of Offer + qualified-rate + walk-away
stage: done
owner_agent: verifier
status: done
depends_on: [T-001]
file_ownership:
  - "packages/flag-engine/**"
spec_refs:
  - "specs/00-shared-core-architecture.md#flag-engine-shared"
  - "decisions/adr/ADR-001-backend-language-node-ts.md"
mock_only: false
---

## Objective

A `packages/flag-engine` package exists containing a pure, provider-agnostic function that consumes an `Offer` (from `packages/core`) plus the buyer's qualified rate and the deal's walk-away number, and emits `flags[]`. No I/O, no provider knowledge, fully unit-tested against fixture offers.

## Acceptance criteria

1. The engine is a pure function of `Offer` + user's qualified-rate + walk-away number, with no side effects and no provider-specific inputs — cites specs/00-shared-core-architecture.md "Flag engine (shared)" ("Provider-agnostic, pure function of `Offer` + user's qualified-rate + walk-away").
2. Emits `payment_packing` when the term is stretched (e.g. 72/84 mo) to shrink the monthly — cites specs/00-shared-core-architecture.md "Flag engine (shared)".
3. Emits `rate_markup` when APR is above what the buyer qualifies for — cites specs/00-shared-core-architecture.md "Flag engine (shared)".
4. Emits `junk_fee` when add-ons/fees are above fair value — cites specs/00-shared-core-architecture.md "Flag engine (shared)".
5. Emits `over_walkaway` when the total crosses the deal's walk-away number — cites specs/00-shared-core-architecture.md "Flag engine (shared)".
6. Flag values are exactly the `Offer.flags[]` enum from `packages/core` (`packing | rate_markup | junk_fee | over_walkaway` per the domain model); no parallel flag type is defined — cites specs/00-shared-core-architecture.md "Core domain model" and decisions/adr/ADR-001-backend-language-node-ts.md "Decision" (no parallel type definitions).
7. Vitest unit tests co-located in the package cover each flag firing and not firing on fixture offers — cites decisions/adr/ADR-001-backend-language-node-ts.md "Consequences" (vitest, one toolchain).

## Notes / constraints

- Depends only on T-001 (`packages/core` types). May run concurrently with T-003..T-008; ownership is disjoint.
- Note the naming wrinkle in specs/00: the domain model's flag enum says `packing` while the flag-engine section says `payment_packing`. The designer must pick one canonical wire value in `packages/core`'s enum and use it consistently; if this requires an interpretive call beyond mapping, flag to the lead (ADR duty per CLAUDE.md).
- Thresholds for "stretched term" and "above fair value" are not numerically specified in the spec — design them as injectable parameters/config of the pure function rather than hard-coding business constants, so no uncited scope is invented.
- Consumer UI foregrounds flags, B2B treats them as advisory (specs/00 "Flag engine (shared)") — that divergence is presentation-layer and out of scope here; the engine itself is shared and identical.

## Log

<!-- append-only; one line per event: YYYY-MM-DD HH:MM · agent · event -->
2026-08-07 12:00 · planner · task created (Epic 1: shared spine + adapter layer, runnable)
2026-08-07 · designer · design doc published (docs/design/T-002.md); stage design → build; naming wrinkle already resolved by ADR-002 (payment_packing); thresholds designed as required injectable config with no defaults (design D1); over_walkaway total read as sale_price + Σ fees (design D2) — all interpretive calls logged in design §0, none blocking
2026-08-07 · builder · implemented packages/flag-engine exactly per design §1–§2 (evaluateOffer + FlagContext/FlagEngineConfig/FeeFairCap, zero deps, no I/O); tsc -p packages/flag-engine --noEmit green; tests left to tester stage; stage build → test
2026-08-07 · tester · test suite added (packages/flag-engine/test/{fixtures.ts,engine.test.ts}): per-flag firing/not-firing (AC-2..5), D4 boundaries, D3 missing inputs, AC-6 vocabulary (runtime + type-level, 'packing' rejected), D5/D7 purity/ordering/idempotency, §4.1 error paths (NaN/negative/malformed config never throw), §4.2 structural posture (sync, closed export surface); 46/46 green via npx vitest run packages/flag-engine; tsc --noEmit green; no implementation changes needed; stage test → validate
2026-08-07 · verifier · validated + reviewed diff main...epic-1-shared-spine for T-002 ownership paths: traceability clean (all interpretive calls logged design §0 D1–D7 with spec/ADR basis; ADR-002 payment_packing honored; AC-1..7 traced), invariants clean (pure/no-I/O, zero deps, OfferFlag vocabulary only, no protected-path or out-of-scope file touched), boundary clean (imports only @core/vitest; no env/endpoint/SDK); independently re-ran npx vitest run packages/flag-engine (46/46 green) and tsc -p packages/flag-engine --noEmit (green); tester on record pass; zero findings → approve; stage validate → done
2026-08-07 · integrator · ADR-005 applied (evaluateOffer now returns FlagEvaluation { flags, unevaluable }: flags with missing required inputs are not emitted and surface as unevaluable — never defaulted to zero; payment_packing evaluable from term alone, over_walkaway requires sale_price, rate_markup requires apr+qualified_apr, junk_fee always evaluable; tests adapted + ADR-005 suites added, 55/55 green, tsc green)
