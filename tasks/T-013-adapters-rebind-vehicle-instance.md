---
id: T-013
title: Adapter layer rebound to VehicleInstance (valuation, NHTSA, vehicle-history, credit-prequal)
stage: validate
owner_agent: tester
status: in_progress
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
undefined · tester · packages/adapters/** test trees migrated to v0.5 and extended per docs/design/T-013.md §9 + the kit mandates: 364 passing, 0 failing, 1 skipped (packages/adapters/nhtsa/test/live-smoke.test.ts — opt-in NHTSA_LIVE=1, reported skipped per ADR-008, never faked; T-013 has no DB-dependent test, so the DATABASE_URL rule has no subject here). Rewrote the three stale valuation suites and nhtsa/test/vehicle-data.test.ts + live-smoke.test.ts against the frozen spine; added packages/adapters/valuation/test/helpers.ts (spine-typed request/instance/snapshot builders), valuation/test/posture.test.ts, nhtsa/test/posture.test.ts, vehicle-history/test/t013-instance-binding.test.ts, credit-prequal/test/t013-posture.test.ts, plus three test-scope node-shim.d.ts files (@types/node stays absent). Coverage added for every §7 error row and each design interpretive call: AC-1 instance-stamped snapshots incl. two threads on one car spec and the removed vehicle{}/values{}/mileage/fetched_at fields; AC-2/D3 mileage, condition and trim each proven load-bearing alone and composed, year load-bearing through the match key, additions deliberately unpriced; AC-6/Q16 regression gate (4-char, unknown, empty, emoji and SQL-ish VINs all fall through to the spec key rather than erroring, and a VIN-less instance still values); D2 make/model-mismatch rejection plus @ts-expect-error gates that VehicleInstance has no make/model and VehicleTarget.make/model are write-once; ADR-005 partial blends omit bands (asserted absent, never 0) and total failure is an error rather than an all-zero snapshot; ADR-007 the retail band survives single-source and blended paths and a foreign-instance contributor's retail can never land on this instance; D6 discard incl. an all-foreign input and the composite's §3.4 relabelling; D7/D9/D10 toVehicleData is instance-bound, recalls:[] only reachable from a successful call, and no-VIN⇒no-record is a compile error (@ts-expect-error against decodeVin/getRecalls/getHistory); D12 credit-prequal has no vehicle binding and no field able to hold raw credit data. Structural posture gates scan each src tree with comments stripped (the doc comments deliberately name the forbidden things): no fetch/URL/env read/credential/transport import in valuation, vehicle-history or credit-prequal; nhtsa's fetch confined to adapter.ts, injectable, credential-free, and only the two free NHTSA hosts referenced; Q15 no comps/marketplace/scraping symbol anywhere; Q13 no Dealership/DealershipContact/address; Q20 no walk_away/budget path into a request; no account/owner/deal/thread id anywhere in the layer; no audio, transcript, transcription, recording_url, speech or voicemail token in any adapter file; no update/delete affordance and no module-level mutable state; no spine type redefined (ADR-001) and no runtime dependency in any of the four manifests. All four packages pass npx tsc -p packages/adapters/<pkg> --noEmit. NO implementation change was made or needed; the only fixes were mine and test-only. One design-level observation for the reviewer, NOT a defect against the design: §7.2 row 4 filters blend survivors against the HEAD snapshot while §3.4 then stamps req.instance.id, so a hypothetical source that answers about a car it was not asked about would have its bands relabelled onto the requested instance while the honest contributor is discarded — §8's ADR-007 claim is stronger than what the head-based filter delivers. Unreachable today (both mocks stamp req.instance.id, which is now asserted); pinned by a named test so it is recorded rather than latent. Filtering survivors against req.instance.id inside createBlendedValuationAdapter would close it. stage test → validate
