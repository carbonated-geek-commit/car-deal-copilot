---
id: T-002
title: Flag engine — pure function of Offer + qualified-rate + walk-away
stage: build
owner_agent: designer
status: pending
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
