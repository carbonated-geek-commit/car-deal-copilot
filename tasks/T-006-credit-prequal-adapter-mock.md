---
id: T-006
title: Credit prequal adapter — pass-through mock (token + prequal results only)
stage: build
owner_agent: designer
status: pending
depends_on: [T-001]
file_ownership:
  - "packages/adapters/credit-prequal/**"
spec_refs:
  - "specs/01-consumer-product-spec.md#credit-data-residency-resolved-2026-08-07"
  - "specs/00-shared-core-architecture.md#integrations--anti-corruption--adapter-layer-shared"
  - "decisions/adr/ADR-001-backend-language-node-ts.md"
mock_only: true
---

## Objective

A `packages/adapters/credit-prequal` package exists with a mock credit-provider adapter modeling the pass-through hosted-flow shape: the (mock) soft pull happens in the provider's hosted flow, and the adapter returns only a provider token plus prequal results (qualified APR, amounts). The adapter's types make it structurally impossible for raw credit data to enter our systems — no fields for it exist anywhere in the interface.

## Acceptance criteria

1. The adapter models pass-through only: the soft pull runs in the (mocked) provider's hosted flow; our side receives and stores a provider token + prequal results (qualified APR, amounts) and nothing else — cites specs/01-consumer-product-spec.md "Credit data residency" ("Pass-through only. ... we store a provider token + prequal results (qualified APR, amounts) and nothing else.").
2. No type, field, or return value in the adapter interface or mock can carry raw credit data (report contents, tradelines, scores beyond the prequal outputs); raw credit data never lands in our systems — cites specs/01-consumer-product-spec.md "Credit data residency" ("Raw credit data never lands in our systems").
3. The adapter sits behind an internal interface; callers never see a provider-specific (Array/Plaid/MeasureOne/bureau) shape — cites specs/00-shared-core-architecture.md "Integrations — anti-corruption / adapter layer (shared)" ("Core services never see a provider's shape.").
4. Vitest tests co-located in the package verify the hosted-flow round trip against fixtures and assert (e.g. via type-level or serialization checks) that only token + prequal fields exist on outputs — cites decisions/adr/ADR-001-backend-language-node-ts.md "Consequences" (vitest, one toolchain).

## Notes / constraints

- **mock_only: true.** Credit providers (Array / Plaid / MeasureOne / bureau resellers) are on the CLAUDE.md "MOCK-ONLY until Corban signs contracts/credentials" list. No live credentials, endpoints, or provider SDKs. Credential absence is the structural enforcement.
- The prequal output (qualified APR) is the flag engine's `rate_markup` input (specs/00 "Flag engine (shared)") — coordinate the output type with `packages/core` contracts from T-001 rather than inventing a local one.
- The full FCRA/GLBA data-holder build is intentionally avoided per specs/01 "Credit data residency" — do not design storage, encryption, or retention machinery for credit report data; it must not exist.
- Depends only on T-001. Runs concurrently with T-002..T-005, T-007, T-008; ownership disjoint.

## Log

<!-- append-only; one line per event: YYYY-MM-DD HH:MM · agent · event -->
2026-08-07 12:00 · planner · task created (Epic 1: shared spine + adapter layer, runnable)
undefined · designer · design doc produced (docs/design/T-006.md); interpretive calls D1-D6 logged; stage design → build
