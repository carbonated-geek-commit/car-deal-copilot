# ADR-002: Canonical flag name is `payment_packing`

- **Date:** 2026-08-07
- **Author:** chief-architect (session role)
- **Status:** accepted
- **Trigger:** specs/00 names the same flag `packing` in the Offer model's flags enum but `payment_packing` in the Flag engine section. Planner flagged it (T-002 notes); the spine types (T-001) and flag engine (T-002) both need one name before build.

## Decision
The canonical flag identifier in `packages/core` and everywhere downstream is **`payment_packing`**. The Offer model's `packing` is read as shorthand for the same flag, not a second flag.

## Spec basis
`specs/00-shared-core-architecture.md` → "Core domain model" (Offer.flags enum) and "Flag engine" (payment_packing definition). The Flag engine section is the semantic definition ("term stretched to shrink the monthly"); the enum entry is a compressed reference to it.

## Alternatives considered
- **`packing`** — shorter, but ambiguous outside the finance-office context and the Flag engine section (the behavioral definition) already uses `payment_packing`.

## Consequences
- `packages/core` Offer type declares `flags: ('payment_packing' | 'rate_markup' | 'junk_fee' | 'over_walkaway')[]`.
- T-001 and T-002 are bound by this; no other flag names may be introduced without a spec line or a superseding ADR.
