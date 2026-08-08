---
id: T-018
title: S3-compatible object store adapter — attachments, documents, dossiers (no audio)
stage: build
owner_agent: designer
status: in_progress
depends_on: [T-012, T-015]
file_ownership:
  - "packages/object-store/src/**"
  - "packages/object-store/test/**"
  - "packages/object-store/package.json"   # scripts field ONLY, per ADR-009
spec_refs:
  - "specs/00-shared-core-architecture.md#core-domain-model"
  - "specs/00-shared-core-architecture.md#integrations--anti-corruption--adapter-layer-shared"
  - "specs/00-shared-core-architecture.md#receipt-layer-trust-engine"
  - "specs/01-consumer-product-spec.md#account-model-the-piece-we-locked"
  - "specs/01-consumer-product-spec.md#consent--recording-posture-resolved-2026-08-07"
  - "decisions/adr/ADR-001-backend-language-node-ts.md"
mock_only: false
---

## Objective

`packages/object-store` provides one internal interface for durable object storage over an S3-compatible backend, holding exactly what the spec assigns to the object store: email attachments, uploaded documents, and generated dossiers. Keys are account-scoped, no read path crosses an account, and **no code path can store audio**. Callers see the internal interface only — the SDK's shape never reaches them — so a different S3-compatible provider is a wiring change.

## Acceptance criteria

1. A single internal object-store interface is exported and no caller ever sees the provider SDK's request/response shape — cites specs/00-shared-core-architecture.md "Integrations — anti-corruption / adapter layer (shared)" ("Every external feed sits behind one internal interface. Core services never see a provider's shape.").
2. The adapter stores and retrieves email attachments, uploaded documents, and generated dossiers — cites specs/00-shared-core-architecture.md "Core domain model" (Store: "object store (S3 or equiv.) for email attachments, uploaded documents, and generated dossiers").
3. There is no audio path: no method, content type allowlist entry, or key convention permits storing a recording, and this is covered by test — cites specs/00-shared-core-architecture.md "Core domain model" (Store: "No audio is stored") and specs/01-consumer-product-spec.md "Consent & recording posture" ("no audio is ever captured or stored").
4. Object keys are account-scoped and every read is scoped to the requesting account, so one account's artifacts are not addressable from another — cites specs/01-consumer-product-spec.md "Account model" ("`Account` owns `Deals`") and specs/00-shared-core-architecture.md "Dealership data tenancy" (the tenancy principle: private data never exposed to another account).
5. A stored object is addressed by a stable reference that Postgres rows can carry, so the relational core holds references and the object store holds bytes — cites specs/00-shared-core-architecture.md "Core domain model" (Store split between Postgres and the object store).
6. A generated deal dossier can be persisted and retrieved as a durable, exportable artifact; rendering it remains the receipt package's concern — cites specs/00-shared-core-architecture.md "Receipt layer (trust engine)" ("Generates a shareable **deal dossier** (PDF + web link)" and "exportable").
7. Stored dossier and document artifacts are never mutated in place — a revision is a new object, so the receipt trail's append-only property is not undermined by the storage layer — cites specs/00-shared-core-architecture.md "Receipt layer (trust engine)" ("append-only").
8. The adapter defines no spine type of its own; anything domain-shaped is imported from `packages/core` — cites decisions/adr/ADR-001-backend-language-node-ts.md "Decision".

## Notes / constraints

- Tests run against a locally provisioned S3-compatible endpoint or an in-process fake. **No cloud credentials belong in the repo** — credential absence is the structural enforcement the constitution relies on.
- Depends on T-012 because the dossier structure it persists is defined by the realigned receipt package.
- Manifests (`packages/object-store/package.json`, `tsconfig.json`) belong to T-015; a missing dependency is an escalation to the lead.
- No CDN, signing service, or image-processing service is introduced — those are unlisted integrations and would require escalation.
- Do not touch protected paths: `CLAUDE.md`, `thesis.md`, `specs/**`, `.claude/**`.

## Log

<!-- append-only; one line per event: YYYY-MM-DD HH:MM · agent · event -->
2026-08-07 14:00 · planner · task created (Epic 2 Half B: persistence & API spine)
2026-08-07 · designer · design complete → docs/design/T-018.md; stage design → build. Notes to lead: D5 (RawPayloadStore is sync, S3 is not — resolved as write-behind within ownership; recommend a follow-up task make the T-014 port async) and D6 (@object-store → @comms import edge, authorized by ADR-009 §1, amends T-015 §2.2). Not blocked.
