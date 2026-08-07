---
id: T-003
title: Valuation adapters — KBB-mock + Manheim-mock behind one interface
stage: design
owner_agent: designer
status: pending
depends_on: [T-001]
file_ownership:
  - "packages/adapters/valuation/**"
spec_refs:
  - "specs/00-shared-core-architecture.md#valuation"
  - "specs/00-shared-core-architecture.md#integrations--anti-corruption--adapter-layer-shared"
  - "specs/00-shared-core-architecture.md#core-domain-model"
  - "decisions/adr/ADR-001-backend-language-node-ts.md"
mock_only: true
---

## Objective

A `packages/adapters/valuation` package exists with two mock adapter implementations — KBB-mock (retail/trade-in) and Manheim-mock (wholesale/MMR) — both implementing the single valuation adapter interface from `packages/core`, plus a blend step that combines them into a wholesale vs trade-in vs retail view emitted as a `ValuationSnapshot`. Deterministic fixture data drives both mocks; tests run fully offline.

## Acceptance criteria

1. Both mocks implement the one valuation interface exported by `packages/core`; no caller can see a KBB- or Manheim-specific shape — cites specs/00-shared-core-architecture.md "Integrations — anti-corruption / adapter layer (shared)" ("Every external feed sits behind one internal interface. Core services never see a provider's shape.").
2. KBB-mock covers the retail/trade-in need; Manheim-mock covers the wholesale/auction (MMR) need — cites specs/00-shared-core-architecture.md "Valuation" (needs table: Retail/trade-in → KBB; Wholesale/auction → Manheim (MMR)).
3. Adapter outputs blend into **wholesale vs trade-in vs retail** — cites specs/00-shared-core-architecture.md "Valuation" ("Blend into wholesale vs trade-in vs retail.").
4. Results are emitted as the cached, timestamped `ValuationSnapshot` type from `packages/core` (snapshot + cache semantics) — cites specs/00-shared-core-architecture.md "Valuation" ("Snapshot + cache.") and "Core domain model" (`ValuationSnapshot ... (cached, timestamped)`).
5. Vitest tests co-located in the package exercise both mocks and the blend against fixtures, fully offline — cites decisions/adr/ADR-001-backend-language-node-ts.md "Consequences" (vitest, one toolchain).

## Notes / constraints

- **mock_only: true.** KBB and Manheim MMR are on the CLAUDE.md "MOCK-ONLY until Corban signs contracts/credentials" list. This task must NOT request, reference, or wire live credentials, API keys, endpoints, or SDKs for KBB/Manheim — mocks against the internal interface only. Credential absence is the structural enforcement.
- Depends only on T-001. Runs concurrently with T-002, T-004..T-008; ownership disjoint.
- Private-party valuation (marketplace listings / own listings ingest, specs/00 "Valuation" table row 3) is deliberately out of Epic 1 — no ingest pipeline exists yet. Do not stub it beyond leaving the interface open to a third source.
- Mock data should be plausible per-VIN/spec fixtures so the blend view is meaningful in demos and downstream tests.

## Log

<!-- append-only; one line per event: YYYY-MM-DD HH:MM · agent · event -->
2026-08-07 12:00 · planner · task created (Epic 1: shared spine + adapter layer, runnable)
