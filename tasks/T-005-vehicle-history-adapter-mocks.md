---
id: T-005
title: Vehicle-history adapters — Carfax-mock + AutoCheck-mock (accident/title)
stage: design
owner_agent: designer
status: pending
depends_on: [T-001]
file_ownership:
  - "packages/adapters/vehicle-history/**"
spec_refs:
  - "specs/00-shared-core-architecture.md#vehicle-data"
  - "specs/00-shared-core-architecture.md#integrations--anti-corruption--adapter-layer-shared"
  - "specs/00-shared-core-architecture.md#core-domain-model"
  - "decisions/adr/ADR-001-backend-language-node-ts.md"
mock_only: true
---

## Objective

A `packages/adapters/vehicle-history` package exists with mock adapter implementations for Carfax and AutoCheck (accident/title history), both implementing the vehicle-data adapter interface from `packages/core`. Deterministic per-VIN fixtures drive the mocks; tests run fully offline.

## Acceptance criteria

1. Both mocks implement the vehicle-data interface exported by `packages/core`; no caller sees a Carfax- or AutoCheck-specific shape — cites specs/00-shared-core-architecture.md "Integrations — anti-corruption / adapter layer (shared)" ("Core services never see a provider's shape.").
2. Covers the "Accident / title" need attributed to Carfax and AutoCheck — cites specs/00-shared-core-architecture.md "Vehicle data" (needs table: "Accident / title → Carfax, AutoCheck. Paid.").
3. Adapter output maps into the cached, timestamped `VehicleData` type from `packages/core` — cites specs/00-shared-core-architecture.md "Core domain model" (`VehicleData (cached, timestamped)`).
4. Vitest tests co-located in the package exercise both mocks against per-VIN fixtures, fully offline — cites decisions/adr/ADR-001-backend-language-node-ts.md "Consequences" (vitest, one toolchain).

## Notes / constraints

- **mock_only: true.** Carfax and AutoCheck are on the CLAUDE.md "MOCK-ONLY until Corban signs contracts/credentials" list. This task must NOT request, reference, or wire live credentials, endpoints, or SDKs for either provider. Credential absence is the structural enforcement.
- Depends only on T-001. Runs concurrently with T-002..T-004, T-006..T-008; ownership disjoint.
- Fixtures should include at least one clean-history VIN and one accident/branded-title VIN so downstream consumers can exercise both paths.

## Log

<!-- append-only; one line per event: YYYY-MM-DD HH:MM · agent · event -->
2026-08-07 12:00 · planner · task created (Epic 1: shared spine + adapter layer, runnable)
