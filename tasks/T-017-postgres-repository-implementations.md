---
id: T-017
title: Postgres repository implementations behind the unchanged comms ports (account-scoped)
stage: build
owner_agent: designer
status: deferred
depends_on: [T-014, T-016]
file_ownership:
  - "packages/store-pg/src/**"
  - "packages/store-pg/test/**"
  - "packages/store-pg/package.json"   # scripts field ONLY, per ADR-009
spec_refs:
  - "specs/00-shared-core-architecture.md#core-domain-model"
  - "specs/00-shared-core-architecture.md#dealership-data-tenancy"
  - "specs/00-shared-core-architecture.md#receipt-layer-trust-engine"
  - "specs/00-shared-core-architecture.md#comms-aggregation-layer-provider-agnostic--shared"
  - "specs/01-consumer-product-spec.md#account-model-the-piece-we-locked"
  - "decisions/OPEN-QUESTIONS.md (Q12 amended)"
  - "decisions/adr/ADR-001-backend-language-node-ts.md"
  - "decisions/adr/ADR-006-current-offer-rollup-policy.md"
mock_only: false
---

## Objective

`packages/store-pg` provides Postgres-backed implementations of the ports `services/comms` already declares — the comms store (write + read), the receipt store, and the persistence side of raw payload handling — **without changing a single port signature**. Swapping the in-memory implementation for this one is wiring, not redesign. Every repository method takes an account scope, and no query can return or mutate a row outside it. The existing `services/comms` behavioural suite passes against this implementation as well as against the in-memory one.

## Acceptance criteria

1. The Postgres implementations satisfy the existing `services/comms` port interfaces unchanged; no port signature is modified and no parallel store interface is introduced — cites specs/00-shared-core-architecture.md "Core domain model" (Store: "**Postgres** for the relational core (deal → threads → messages → offers)") and decisions/adr/ADR-001-backend-language-node-ts.md "Decision" (no parallel type definitions).
2. Every repository method takes an account scope as a required argument, and no query path exists that omits it — cites specs/01-consumer-product-spec.md "Account model" ("`Account` owns `Deals`") and specs/00-shared-core-architecture.md "Dealership data tenancy".
3. `Dealership` reads and writes are global (no account predicate); `DealershipContact` reads and writes are account-scoped and cannot return another account's row — cites specs/00-shared-core-architecture.md "Dealership data tenancy" ("Dealership names and locations are global; the people are private") and decisions/OPEN-QUESTIONS.md Q12 (AMENDED).
4. The receipt implementation exposes append and read only; it has no update or delete method, and the database rejects such an attempt independently of the code — cites specs/00-shared-core-architecture.md "Receipt layer (trust engine)" ("append-only, timestamped, exportable").
5. `current_offer` is computed and persisted by per-field newest-message-wins accumulation, matching the ratified policy — cites decisions/adr/ADR-006-current-offer-rollup-policy.md "Decision".
6. Message appends are keyed and idempotent under at-least-once redelivery, and the consumer-processed ledger is backed by a unique constraint, so a redelivered provider webhook can never duplicate or drop a dealer message — cites specs/00-shared-core-architecture.md "Comms aggregation layer (provider-agnostic — shared)" ("Provider timeouts must never drop a dealer message").
7. Identity resolution (`identity_ref` → deal) is an exact match over normalized values and stays provider-agnostic — cites specs/00-shared-core-architecture.md "Core domain model" ("`identity_ref` is deliberately provider-agnostic").
8. Attachments, uploaded documents, and generated dossiers are persisted as object-store references; their bytes never land in a Postgres column — cites specs/00-shared-core-architecture.md "Core domain model" (Store: "object store (S3 or equiv.) for email attachments, uploaded documents, and generated dossiers").
9. Reads assemble the `@core` aggregates (deal + threads + instances + messages + current offer) and return spine types, never row shapes leaked from the driver — cites specs/00-shared-core-architecture.md "Core domain model" and decisions/adr/ADR-001-backend-language-node-ts.md "Decision".
10. The behavioural suite that `services/comms` runs against the in-memory store passes unchanged against the Postgres implementation, using a real Postgres instance — cites specs/00-shared-core-architecture.md "Core domain model" (Store: Postgres).
11. A cross-account access attempt is covered by an explicit test proving it returns nothing and mutates nothing — cites specs/00-shared-core-architecture.md "Dealership data tenancy" ("never exposed to another account").

## Notes / constraints

- Depends on T-014 (ports must be at their v0.5 shape) and T-016 (schema must exist).
- **Do not modify `services/comms`.** If a port genuinely cannot be implemented over Postgres without a signature change, stop and message the lead — a port change is a T-014 re-scope, not a store-pg edit.
- Account scoping is the foundation E3's deal-scoped authorization will sit on. Do not implement authorization, roles, or grants here; just make every call scoped so authorization has a place to attach.
- Manifests (`packages/store-pg/package.json`, `tsconfig.json`) belong to T-015; a missing dependency is an escalation.
- Tests require a real Postgres. No cloud credentials belong in the repo; use a locally provisioned instance.
- Do not touch protected paths: `CLAUDE.md`, `thesis.md`, `specs/**`, `.claude/**`.

## Log

<!-- append-only; one line per event: YYYY-MM-DD HH:MM · agent · event -->
2026-08-07 14:00 · planner · task created (Epic 2 Half B: persistence & API spine)
undefined · designer · design published (docs/design/T-017.md); stage design → build; ESCALATION E1 — thread_contact_points FK to dealer_threads blocks bindThreadContact before first contact, needs an additive T-016 migration

2026-08-08 - chief - DEFERRED per ADR-010. The block is real: Epic-1 comms ports are synchronous (in-memory heritage) and Postgres is async, with no synchronous pg client in the approved set. Rather than hide asynchrony behind a hydrate-then-serve unit of work, the ports themselves go async in a future task. Safe to defer because ADR-008 makes in-memory the default, so nothing in the working PoC depends on this. docs/design/T-017.md is retained as the input to that task.
