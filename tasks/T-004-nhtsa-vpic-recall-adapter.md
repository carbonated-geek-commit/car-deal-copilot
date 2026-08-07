---
id: T-004
title: Vehicle-data adapter — NHTSA vPIC + Recall API (live-approved, fixture-tested)
stage: build
owner_agent: designer
status: pending
depends_on: [T-001]
file_ownership:
  - "packages/adapters/nhtsa/**"
spec_refs:
  - "specs/00-shared-core-architecture.md#vehicle-data"
  - "specs/00-shared-core-architecture.md#integrations--anti-corruption--adapter-layer-shared"
  - "specs/00-shared-core-architecture.md#core-domain-model"
  - "decisions/adr/ADR-001-backend-language-node-ts.md"
mock_only: false
---

## Objective

A `packages/adapters/nhtsa` package exists implementing the vehicle-data adapter interface from `packages/core` for VIN decode and recalls, backed by the NHTSA vPIC + Recall API. NHTSA is free and authoritative and is on the approved build-now list, so the adapter may target the real endpoints — but all tests run against recorded fixtures, never the network.

## Acceptance criteria

1. The adapter implements the vehicle-data interface exported by `packages/core`; callers never see the NHTSA response shape — cites specs/00-shared-core-architecture.md "Integrations — anti-corruption / adapter layer (shared)" ("Core services never see a provider's shape.").
2. Covers the "VIN decode + recalls" need via NHTSA vPIC + Recall API — cites specs/00-shared-core-architecture.md "Vehicle data" (needs table: "VIN decode + recalls → NHTSA vPIC + Recall API. Free, authoritative.").
3. Adapter output maps into the cached, timestamped `VehicleData` type from `packages/core` — cites specs/00-shared-core-architecture.md "Core domain model" (`VehicleData (cached, timestamped)`).
4. Vitest tests co-located in the package run entirely against checked-in fixture responses (recorded vPIC/Recall payload shapes); no test performs a network call — cites decisions/adr/ADR-001-backend-language-node-ts.md "Consequences" (vitest, one toolchain).

## Notes / constraints

- **NOT mock-only.** NHTSA vPIC + Recall API is on the CLAUDE.md approved "build and wire now" list — the live HTTP client may be written and pointed at the real public endpoints. No credentials required (free public API); introducing any paid or credentialed variant is out of scope and would require escalation.
- Tests must be hermetic: build against fixtures capturing real vPIC/Recall response shapes. A live smoke test, if included, must be opt-in (skipped by default) so CI never depends on the network.
- Depends only on T-001. Runs concurrently with T-002, T-003, T-005..T-008; ownership disjoint.
- Reliability/repair-cost indices, the crowd-sourced repair ledger, and depreciation/TCO curves (other rows of specs/00 "Vehicle data") are out of Epic 1 scope — this adapter is VIN decode + recalls only.

## Log

<!-- append-only; one line per event: YYYY-MM-DD HH:MM · agent · event -->
2026-08-07 12:00 · planner · task created (Epic 1: shared spine + adapter layer, runnable)
2026-08-07 · designer · design doc published (docs/design/T-004.md); interpretive calls D1–D9 logged; stage → build
