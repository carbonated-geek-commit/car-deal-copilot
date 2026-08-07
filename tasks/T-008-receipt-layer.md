---
id: T-008
title: Receipt layer — append-only store contract + dossier export stub
stage: design
owner_agent: designer
status: pending
depends_on: [T-001]
file_ownership:
  - "packages/receipt/**"
spec_refs:
  - "specs/00-shared-core-architecture.md#receipt-layer-trust-engine"
  - "specs/00-shared-core-architecture.md#core-domain-model"
  - "decisions/adr/ADR-001-backend-language-node-ts.md"
mock_only: false
---

## Objective

A `packages/receipt` package exists containing the receipt-layer contract and an in-memory reference implementation: an append-only, timestamped store for receipt entries (recordings-refs, transcripts, SMS, email) keyed by a deal's `receipt_bundle_id`, plus a dossier-export stub that assembles a bundle's entries into an exportable dossier structure. The design makes append-only **structural**: the store interface exposes no update or delete operation at all, so immutability is enforced by the API surface, not by convention.

## Acceptance criteria

1. Every receipt entry (recording-ref, transcript, SMS, email) is append-only and timestamped — cites specs/00-shared-core-architecture.md "Receipt layer (trust engine)" ("Every recording, transcript, SMS, email is append-only, timestamped, exportable").
2. The store contract is structurally append-only: the interface exposes append and read operations only — no update, delete, overwrite, or truncate method exists on any receipt type, verified by the type surface and by tests — cites specs/00-shared-core-architecture.md "Receipt layer (trust engine)" ("append-only").
3. Bundles are addressed by the deal's `receipt_bundle_id` from the `packages/core` `Deal` type — cites specs/00-shared-core-architecture.md "Core domain model" (`Deal ... receipt_bundle_id`).
4. A dossier-export stub exists: given a bundle, it produces an ordered, timestamped dossier structure representing the shareable deal dossier; actual PDF rendering and web-link hosting are stubbed — cites specs/00-shared-core-architecture.md "Receipt layer (trust engine)" ("Generates a shareable deal dossier (PDF + web link)").
5. Vitest tests co-located in the package cover append, chronological read-back, and export assembly, and assert immutability (appended entries are never mutated by any exposed operation) — cites decisions/adr/ADR-001-backend-language-node-ts.md "Consequences" (vitest, one toolchain).

## Notes / constraints

- Epic 1 is in-memory only: the durable backing (Postgres rows + S3 objects per specs/00 "Core domain model" Store) is a later epic. Design the store contract so a Postgres/S3 implementation can slot in behind the same append-only interface without changing it.
- Dossier export is a **stub**: correct structure and ordering, no PDF engine, no link hosting, no new dependencies for rendering.
- Product-specific emphasis (consumer trust proof / concierge deliverable vs B2B audit artifact, per specs/00 "Receipt layer (trust engine)") does not change the model — build one shared layer, no product branching.
- Depends only on T-001. Runs concurrently with T-002..T-007; ownership disjoint. T-009 will write receipt entries via this contract in a later wiring step if not directly in Epic 1 — the comms service task treats this package as an optional consumer, not an owner.

## Log

<!-- append-only; one line per event: YYYY-MM-DD HH:MM · agent · event -->
2026-08-07 12:00 · planner · task created (Epic 1: shared spine + adapter layer, runnable)
