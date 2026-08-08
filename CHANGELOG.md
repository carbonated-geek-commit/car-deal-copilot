# Changelog

## Epic 1 — Shared spine + adapter layer (2026-08-07)

Branch `epic-1-shared-spine`, tasks T-001..T-009. 493 tests passing (+1 opt-in live smoke, skipped by default) across 26 test files, run via `npx vitest run` from the repo root.

### Added

- **T-001 — Monorepo scaffold + core spine** (`packages/core`): npm-workspaces monorepo (ADR-003), `@deal-copilot/*` package names with bare TS aliases and root-owned lockfile (ADR-004), core domain model (`Deal`, `Offer`, `Vehicle`), event contracts, and adapter port interfaces.
- **T-002 — Flag engine** (`packages/flag-engine`): pure function of Offer + qualified rate + walk-away price producing deal flags, including `payment_packing` (ADR-002); missing flag inputs render a flag unevaluable — never silently zero (ADR-005).
- **T-003 — Valuation adapter mocks** (`packages/adapters/valuation`): KBB-mock and Manheim-mock behind a single `ValuationAdapter` interface plus a blend strategy. Mock-only pending live credentials.
- **T-004 — NHTSA vehicle-data adapter** (`packages/adapters/nhtsa`): live-approved vPIC decode + Recall API adapter, zero-dependency with injectable fetch; tests are hermetic against checked-in recorded fixtures, with an opt-in live smoke test.
- **T-005 — Vehicle-history adapter mocks** (`packages/adapters/vehicle-history`): Carfax-mock and AutoCheck-mock (accident/title data) behind one provider-agnostic history interface. Mock-only pending live credentials.
- **T-006 — Credit prequal adapter mock** (`packages/adapters/credit-prequal`): pass-through hosted-flow mock exposing token + prequal results only, per the credit-data-residency decision. Mock-only pending live credentials.
- **T-007 — Offer extraction v1** (`packages/offer-extraction`): pure rule-based extractor (normalize + per-field rules + span claiming) turning transcripts/SMS/email text into partial Offers; `ExtractedOffer` collapses into `Offer` per ADR-005.
- **T-008 — Receipt layer** (`packages/receipt`): append-only receipt store contract with in-memory reference implementation and dossier export stub.
- **T-009 — Comms aggregation service** (`services/comms`): in-memory transport-neutral service — ack-then-queue webhook intake, at-least-once queue with DLQ, authoritative identity routing, stubbed transcription, extraction via `@offer-extraction`, and `current_offer` rollup per ADR-006.

### Decisions ratified

ADR-001 (Node/TS backend), ADR-002 (`payment_packing` flag name), ADR-003 (npm workspaces, no pnpm), ADR-004 (`@deal-copilot/*` naming, bare aliases, root lockfile owned by T-001), ADR-005 (`Offer.sale_price` optional; unevaluable-flag semantics; events carry partial Offers unchanged), ADR-006 (`current_offer` rollup policy).

### Pending live integrations (mock-only, awaiting credentials — Corban follow-up)

KBB, Manheim, Carfax, AutoCheck, credit prequal provider.
