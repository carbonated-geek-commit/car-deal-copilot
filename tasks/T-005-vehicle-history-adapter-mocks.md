---
id: T-005
title: Vehicle-history adapters — Carfax-mock + AutoCheck-mock (accident/title)
stage: done
owner_agent: verifier
status: done
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
2026-08-07 12:34 · designer · design doc produced (docs/design/T-005.md); stage design → build; no blockers, interpretive calls D1–D5 logged in doc
2026-08-07 · builder · package implemented per design (src only; tests left to tester); tsc -p package clean; stage build → test
2026-08-07 · tester · co-located vitest suites written (test/carfax-mock, test/autocheck-mock, test/contract); 63 tests pass offline, tsc clean; error table T-001 §5.1 covered row by row incl. auth-unreachable; stage test → validate
undefined · verifier · validated: diff scoped to ownership+design+task file; traceability to specs/00 vehicle-data/anti-corruption/core-domain-model, ADR-001/ADR-003/ADR-004 confirmed (D1–D5 all logged with basis); mock-only structural (zero deps, no I/O, no URL/credential/env surface, auth code unreachable per contract test); re-ran vitest 63/63 pass + tsc -p package clean; zero findings; approve=true; stage validate → done
