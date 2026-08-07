---
id: T-001
title: Monorepo scaffold + core spine contracts (packages/core)
stage: validate
owner_agent: builder
status: pending
depends_on: []
file_ownership:
  - "package.json"
  - "package-lock.json"
  - "tsconfig.base.json"
  - "vitest.config.*"
  - "vitest.workspace.ts"
  - ".gitignore"
  - "packages/core/**"
spec_refs:
  - "specs/00-shared-core-architecture.md#core-domain-model"
  - "specs/00-shared-core-architecture.md#integrations--anti-corruption--adapter-layer-shared"
  - "specs/00-shared-core-architecture.md#async-backbone-shared"
  - "specs/00-shared-core-architecture.md#comms-aggregation-layer-provider-agnostic--shared"
  - "decisions/adr/ADR-001-backend-language-node-ts.md"
mock_only: false
---

## Objective

A buildable TypeScript monorepo exists with workspace tooling (pnpm workspaces, vitest, shared tsconfig) and a single `packages/core` package containing: the shared spine domain types (`Deal`, `DealerThread`, `Message`, `Offer`, `ValuationSnapshot`, `VehicleData`), the adapter interface contracts (valuation, vehicle-data, telephony, email), and the event contracts for the async backbone. This is the only Phase-0 task; every other Epic 1 task imports from it. It must build and pass a smoke test standalone, with no other packages present.

## Acceptance criteria

1. `packages/core` exports TypeScript types for `Deal` (id, owner_id, path, status, target_vehicle, resolved_vehicle, budget, walk_away_number, identity_ref, dealer_threads[], offers[], receipt_bundle_id, created_at, burned_at), `DealerThread` (dealer_id/name, contact info, messages[], current_offer), `Message` (channel call|sms|email, direction in|out, body|recording_url|transcript, timestamp, extracted_offer?), and `Offer` (sale_price, fees[], apr, term_months, monthly, flags[] with packing|rate_markup|junk_fee|over_walkaway) — field-for-field per specs/00-shared-core-architecture.md "Core domain model".
2. `packages/core` exports `ValuationSnapshot` and `VehicleData` as cached, timestamped types — cites specs/00-shared-core-architecture.md "Core domain model" (`ValuationSnapshot · VehicleData (cached, timestamped)`).
3. `identity_ref` is a provider-agnostic reference type (points at a number + inbox without encoding who provisioned it) — cites specs/00-shared-core-architecture.md "Core domain model" ("`identity_ref` is deliberately provider-agnostic").
4. The spine types are defined exactly once in this package and nowhere else; no parallel type definitions exist in the repo — cites decisions/adr/ADR-001-backend-language-node-ts.md "Decision" ("defined once as TypeScript types in a shared package and imported everywhere — no parallel type definitions").
5. `packages/core` exports adapter interface contracts for valuation, vehicle-data, telephony, and email such that core services depend only on these interfaces and never on a provider's shape — cites specs/00-shared-core-architecture.md "Integrations — anti-corruption / adapter layer (shared)" ("Every external feed sits behind one internal interface. Core services never see a provider's shape.").
6. `packages/core` exports event contracts covering inbound-comms processing, transcription, offer extraction, valuation refresh, and alert dispatch — cites specs/00-shared-core-architecture.md "Async backbone (shared)".
7. The event contracts support the webhook rule that acks are immediate and all heavy work (transcription, extraction) runs on the event bus — cites specs/00-shared-core-architecture.md "Comms aggregation layer (provider-agnostic — shared)" ("webhooks ack immediately, all heavy work ... runs on the event bus").
8. Workspace tooling: pnpm workspaces + vitest + shared tsconfig, one TS toolchain repo-wide; `packages/core` builds and its tests run green with no other package present — cites decisions/adr/ADR-001-backend-language-node-ts.md "Consequences" (monorepo layout, "Test tooling: vitest ... one toolchain").

## Notes / constraints

- Phase 0. No dependencies; everything in Epic 1 depends on this task. Keep it buildable solo — no imports from packages that don't exist yet.
- Contracts only in `packages/core`: types + interfaces + a small amount of pure helper code at most. No provider logic, no I/O, no adapter implementations (those are T-003..T-006).
- Reserve (but do not create) the directory conventions for downstream tasks per ADR-001: `packages/flag-engine`, `packages/adapters/<name>`, `services/comms`.
- Do not touch protected paths: `CLAUDE.md`, `thesis.md`, `specs/**`, `.claude/**`.
- Postgres/S3 are the eventual store per specs/00 "Core domain model" (Store), but no DB wiring in this task — types and contracts only.

## Log

<!-- append-only; one line per event: YYYY-MM-DD HH:MM · agent · event -->
2026-08-07 12:00 · planner · task created (Epic 1: shared spine + adapter layer, runnable)
2026-08-07 · designer · design doc published (docs/design/T-001.md); stage design → build; note: npm workspaces per orchestration constraint, pnpm-workspace.yaml intentionally not created (design D1)
2026-08-07 · designer · idempotent verification pass: design confirmed complete vs specs/00 + ADR-001/002; D1 and §9 updated to cite ADR-003 (deviation resolved, none open)
2026-08-07 · builder · built per design: root scaffold (npm install run once; package-lock.json committed as install artifact), packages/core contracts + trivial smoke spec; tsc --noEmit green, "npx vitest run packages/core" green (vitest 3.2.7 honors workspace file with deprecation notice); deviation note: core package.json marker named "@deal-copilot/core" — npm rejects bare "@core" as a package name; @core alias maps unchanged; stage build → test
2026-08-07 · tester · test suite written per design §2–§6 (5 new specs in packages/core/test: domain/adapters/events contracts, webhook ack-then-queue + identity routing, spine invariants; + node-shim.d.ts test-scope ambient types since @types/node is not in the approved devDeps); 78/78 green via "npx vitest run packages/core", "tsc -p packages/core --noEmit" green; note for validator: §5.2 quarantine path has no dedicated typed payload — expressible only via generic EventEnvelope (T-009 must define it); stage test → validate
2026-08-07 · fixer · verifier medium finding fixed: §5.2 quarantine payload is now a first-class core contract (CommsInboundQuarantinedV1 + CommsInboundPayloadV1 union in SpineEvent, pure isQuarantinedInbound guard); tests updated to consume it (local QuarantinedInboundV1 removed, quarantine SpineEvent coverage added), 82/82 green + tsc --noEmit green; high finding (package-lock.json ownership) and low finding (@deal-copilot/core name) require chief re-scope / designer-or-chief ratification per verifier's own remedy — escalated, no code change made
2026-08-07 · chief · escalations resolved: ADR-004 ratifies @deal-copilot/* npm naming (bare aliases unchanged) and adds package-lock.json to T-001 file_ownership (re-scope); both verifier findings now citable-resolved; stage remains validate for re-verify
2026-08-07 · integrator · ADR-005 applied (core Offer.sale_price now optional `sale_price?: MoneyCents` — absent = dealer did not state a price; no core test asserted required-ness, 82/82 still green)
