---
id: T-013
title: Adapter layer rebound to VehicleInstance (valuation, NHTSA, vehicle-history, credit-prequal)
stage: test
owner_agent: builder
status: built
depends_on: [T-010]
file_ownership:
  - "packages/adapters/**"
spec_refs:
  - "specs/00-shared-core-architecture.md#core-domain-model"
  - "specs/00-shared-core-architecture.md#budget-ceiling-vs-fair-price--two-different-questions-resolved-2026-08-07"
  - "specs/00-shared-core-architecture.md#integrations--anti-corruption--adapter-layer-shared"
  - "specs/00-shared-core-architecture.md#valuation"
  - "specs/00-shared-core-architecture.md#vehicle-data"
  - "specs/01-consumer-product-spec.md#credit-data-residency-resolved-2026-08-07"
  - "specs/01-consumer-product-spec.md#backlog-explicitly-out-of-current-scope"
  - "decisions/OPEN-QUESTIONS.md (Q3, Q13, Q15, Q16)"
  - "decisions/adr/ADR-001-backend-language-node-ts.md"
mock_only: true
---

## Objective

All four adapter packages — `valuation` (KBB-mock, Manheim-mock, blend), `nhtsa` (vPIC + recalls), `vehicle-history` (Carfax-mock, AutoCheck-mock), and `credit-prequal` (pass-through mock) — compile and pass against the v0.5 spine. Valuation and vehicle-data outputs are bound to a `vehicle_instance_id` and are requested with the instance's own year, trim, mileage, and condition, so a valuation of a bare make/model is not expressible. Mock-only adapters remain mock-only; the credit adapter's pass-through residency posture is untouched.

## Acceptance criteria

1. Every `ValuationSnapshot` produced by the valuation adapters carries a `vehicle_instance_id`, and the adapter interface offers no path to produce a snapshot without one — cites specs/00-shared-core-architecture.md "Core domain model" (`ValuationSnapshot (ALWAYS of one specific car — never of a bare make/model) ├── vehicle_instance_id`).
2. A valuation request carries the priceable attributes of the specific car — year, trim, mileage, condition — rather than a make/model pair — cites specs/00-shared-core-architecture.md "Budget ceiling vs. fair price — two different questions" ("no valuation source can price *Honda Accord* without year, trim, mileage, and condition, and all four vary per thread").
3. Every `VehicleData` produced by the NHTSA and vehicle-history adapters carries a `vehicle_instance_id` — cites specs/00-shared-core-architecture.md "Core domain model" (`VehicleData (decode, recalls, history for one specific car) ├── vehicle_instance_id`).
4. The blend step still produces the wholesale vs trade-in vs retail view, now per instance — cites specs/00-shared-core-architecture.md "Valuation" ("Blend into **wholesale vs trade-in vs retail**. Snapshot + cache.").
5. All adapters still sit behind the single internal interface set from `packages/core`; no provider shape reaches a caller — cites specs/00-shared-core-architecture.md "Integrations — anti-corruption / adapter layer (shared)" ("Every external feed sits behind one internal interface. Core services never see a provider's shape.").
6. VIN remains user-entered and unvalidated: no adapter performs or requires a VIN decode as a precondition for producing a valuation or for accepting a `VehicleInstance` — cites decisions/OPEN-QUESTIONS.md Q16 ("VIN is **user-entered and unvalidated** at launch — the buyer's own record, not a lookup key") and specs/01-consumer-product-spec.md "Backlog" item 4.
7. The KBB, Manheim, Carfax, AutoCheck, and credit-provider adapters remain mock/fixture-driven with no credential reference and no network call — cites specs/00-shared-core-architecture.md "Integrations — anti-corruption / adapter layer (shared)" and specs/00 "Valuation" / "Vehicle data" (licensed/paid feeds).
8. NHTSA vPIC + Recall remains the live-approved vehicle-data source, with all tests still running against recorded fixtures rather than the network — cites specs/00-shared-core-architecture.md "Vehicle data" ("VIN decode + recalls | **NHTSA vPIC + Recall API** | Free, authoritative.").
9. No private-party comps source is added: KBB private-party value comes through the existing KBB mock and there is no marketplace integration or scraping path — cites decisions/OPEN-QUESTIONS.md Q15 (RESOLVED) and specs/01-consumer-product-spec.md "Backlog" item 6.
10. The credit-prequal adapter's pass-through posture is unchanged: token + prequal results only, no field anywhere able to carry raw credit data — cites specs/01-consumer-product-spec.md "Credit data residency" ("we store a provider token + prequal results (qualified APR, amounts) and nothing else") and decisions/OPEN-QUESTIONS.md Q3.
11. No adapter redefines a spine type; all shared vocabulary is imported from `packages/core` — cites decisions/adr/ADR-001-backend-language-node-ts.md "Decision".
12. All four packages typecheck and their tests pass fully offline against the v0.5 spine.

## Notes / constraints

- `mock_only: true` — this task touches KBB, Manheim, Carfax, AutoCheck, and the credit provider, all of which are **mock-only until Corban signs contracts/credentials**. Requesting, purchasing, or wiring live access is an escalation, not a design call.
- No dealership-directory data source is introduced anywhere here (Q13: user-entered at launch, batch import later, no Maps/business API).
- Owns `packages/adapters/**` only. It does not modify `packages/core` (T-010) or `services/comms` (T-014).
- Do not touch protected paths: `CLAUDE.md`, `thesis.md`, `specs/**`, `.claude/**`.

## Log

<!-- append-only; one line per event: YYYY-MM-DD HH:MM · agent · event -->
2026-08-07 14:00 · planner · task created (Epic 2 Half A: v0.5 domain migration)
2026-08-07 · designer · design complete — docs/design/T-013.md (13 interpretive calls D1–D13; valuation + nhtsa carry the code change, vehicle-history + credit-prequal are verification-only); stage design → build
undefined · builder · build complete — valuation src rebound to VehicleInstance (instance-bound snapshots, year/trim/mileage/condition all load-bearing, VIN unvalidated fall-through, KBB private_party band, foreign-instance blend discard); nhtsa toVehicleData(instance, parts, captured_at) + VehicleDataParts; vehicle-history doc guarantees; credit-prequal untouched. All four src trees typecheck; vehicle-history + credit-prequal suites green (94). Existing valuation/nhtsa test files still reference the pre-v0.5 spine and are left for the tester stage. stage build → test
