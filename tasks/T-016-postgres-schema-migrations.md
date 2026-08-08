---
id: T-016
title: Postgres schema + migrations for the v0.5 relational core (tenancy split, append-only receipt)
stage: validate
owner_agent: tester
status: in_progress
depends_on: [T-010, T-015]
file_ownership:
  - "packages/db/src/**"
  - "packages/db/migrations/**"
  - "packages/db/test/**"
  - "packages/db/package.json"   # scripts field ONLY, per ADR-009
spec_refs:
  - "specs/00-shared-core-architecture.md#core-domain-model"
  - "specs/00-shared-core-architecture.md#cardinality-invariants-structurally-enforced"
  - "specs/00-shared-core-architecture.md#dealership-data-tenancy"
  - "specs/00-shared-core-architecture.md#receipt-layer-trust-engine"
  - "specs/00-shared-core-architecture.md#budget-ceiling-vs-fair-price--two-different-questions-resolved-2026-08-07"
  - "specs/01-consumer-product-spec.md#account-model-the-piece-we-locked"
  - "specs/01-consumer-product-spec.md#consent--recording-posture-resolved-2026-08-07"
  - "specs/01-consumer-product-spec.md#backlog-explicitly-out-of-current-scope"
  - "decisions/OPEN-QUESTIONS.md (Q11 amended, Q12 amended, Q14, Q16)"
  - "decisions/adr/ADR-002-flag-name-payment-packing.md"
  - "decisions/adr/ADR-005-offer-sale-price-optional.md"
mock_only: false
---

## Objective

`packages/db` holds a forward-only migration set that creates the v0.5 relational core in Postgres — accounts, deals, vehicle targets, vehicle instances, dealerships, dealership contacts, dealer threads, messages, offers, and receipt entries — plus the connection/pool module the repository layer will use. Two spec rules are enforced **by the schema, not by application code**: the dealership tenancy split (dealerships global, contacts account-private and unreachable across accounts) and the receipt trail's append-only property (no UPDATE or DELETE path available to the application role). Every account-owned table carries an account scope from the first migration.

## Acceptance criteria

1. Migrations create the relational core covering the deal → threads → messages → offers spine plus accounts, vehicle targets, vehicle instances, dealerships, dealership contacts, and receipt entries — cites specs/00-shared-core-architecture.md "Core domain model" (Store: "**Postgres** for the relational core (deal → threads → messages → offers)").
2. Columns and enums match the v0.5 spine field-for-field: deal `path` and `status`; message `channel` (`call|sms|email|note`), `direction` (`in|out|internal`), `author` (`dealer|buyer|concierge`), and optional call metadata; thread `process_step` (`information_gather|deal_negotiation|deal_approval|financing|final_sale|pickup`); instance `condition` (`new|used|certified`) — cites specs/00-shared-core-architecture.md "Core domain model" (`Deal`, `Message`, `DealerThread`, `VehicleInstance` blocks).
3. `dealerships` is GLOBAL: name, state, city, zip_code, one row per real dealership, with **no** account/owner column, and the table accepts a later bulk import — cites specs/00-shared-core-architecture.md "Dealership data tenancy" ("A `Dealership` record (name, state, city, zip) is shared across all accounts — one row per real dealership, so a directory can be batch-loaded later"), decisions/OPEN-QUESTIONS.md Q12 (AMENDED), and specs/01-consumer-product-spec.md "Backlog" item 5.
4. `dealership_contacts` is PRIVATE: a NOT NULL account reference plus a schema-level constraint (foreign-key composition, row-level security, or equivalent) that makes a contact row belonging to one account unreachable from another — cites specs/00-shared-core-architecture.md "Dealership data tenancy" ("scoped to the account that entered them and **are never exposed to another account**") and decisions/OPEN-QUESTIONS.md Q12 (AMENDED).
5. Every account-owned table carries an account scope, and the foreign-key path from any message, offer, thread, instance, or receipt entry back to its account is enforced in the schema so a cross-account row cannot be joined into existence — cites specs/00-shared-core-architecture.md "Dealership data tenancy" and specs/01-consumer-product-spec.md "Account model" ("`Account` owns `Deals`").
6. Receipt entries are append-only **at the database level**: the role the application connects as has no UPDATE or DELETE privilege on the receipt table, and a trigger or equivalent rejects any attempt, so immutability does not depend on application discipline — cites specs/00-shared-core-architecture.md "Receipt layer (trust engine)" ("Every **buyer note, SMS, email, and call-metadata record** is **append-only, timestamped, exportable**").
7. Each receipt entry row stores its author, so self-authored evidence is distinguishable in the store itself — cites specs/00-shared-core-architecture.md "Receipt layer (trust engine)" ("Each entry carries its **author** ... so self-authored evidence is never presented as if it came from the dealer").
8. A deal has exactly one vehicle target, and the target's make/model are write-once — settable while the deal is `draft`, rejected once any offer is attached — enforced in the schema (constraint or trigger), not only in the API — cites specs/00-shared-core-architecture.md "Cardinality invariants (structurally enforced)" ("`target_vehicle.make`/`model` are write-once — settable while the deal is `draft`, immutable once any offer is attached") and decisions/OPEN-QUESTIONS.md Q11 (AMENDED).
9. Each dealer thread owns its own vehicle instance, and valuation-snapshot and vehicle-data rows key on `vehicle_instance_id` rather than on the deal — cites specs/00-shared-core-architecture.md "Cardinality invariants" ("**each thread carries its own `VehicleInstance`**") and specs/00 "Core domain model" (`ValuationSnapshot ... vehicle_instance_id`).
10. `year_range` is stored as a soft guide: no constraint rejects a vehicle instance whose year falls outside it — cites specs/00-shared-core-architecture.md "Cardinality invariants" (Year drift: "a **soft guide, not a hard rejection**") and decisions/OPEN-QUESTIONS.md Q16.
11. VIN is stored as user-entered free text with no decode-derived validation constraint — cites decisions/OPEN-QUESTIONS.md Q16 ("VIN is **user-entered and unvalidated** at launch") and specs/01-consumer-product-spec.md "Backlog" item 4.
12. No column anywhere stores audio, a recording reference, or a transcript — cites specs/01-consumer-product-spec.md "Consent & recording posture" ("There is no `recording_url` field on `Message` at all") and specs/00-shared-core-architecture.md "Core domain model" (Store: "No audio is stored").
13. Attachments, uploaded documents, and generated dossiers are represented in Postgres as object-store references only, with the bytes living in the object store — cites specs/00-shared-core-architecture.md "Core domain model" (Store: "object store (S3 or equiv.) for email attachments, uploaded documents, and generated dossiers").
14. Offer rows allow an absent sale price and record the flag set including `above_market`, with `payment_packing` as the stored canonical name — cites decisions/adr/ADR-005-offer-sale-price-optional.md "Decision" §1, specs/00-shared-core-architecture.md "Flag engine (shared)" (five-flag list), and decisions/adr/ADR-002-flag-name-payment-packing.md.
15. Migrations run forward from an empty database, are re-runnable without effect, and are verified against a real Postgres instance in test — cites specs/00-shared-core-architecture.md "Core domain model" (Store: Postgres).

## Notes / constraints

- Schema task only: no repository code here (that is T-017). `packages/db/src/**` holds the connection/pool module, migration runner wiring, and any generated schema types — not query implementations.
- Manifests (`packages/db/package.json`, `packages/db/tsconfig.json`) are owned by T-015 and must not be edited here. A missing dependency is an escalation to the lead, not a manifest edit.
- The tenancy split and the append-only receipt are the two rules this task must make *structural*. If Postgres RLS is chosen for the tenancy constraint, that choice is a chief-level ADR (CLAUDE.md "ADR duty") because it shapes every repository call in T-017.
- Authorization is **not** in this epic (E3). This task provides the account scoping the authorization layer will later sit on top of, nothing more.
- Do not touch protected paths: `CLAUDE.md`, `thesis.md`, `specs/**`, `.claude/**`.

## Log

<!-- append-only; one line per event: YYYY-MM-DD HH:MM · agent · event -->
2026-08-07 14:00 · planner · task created (Epic 2 Half B: persistence & API spine)
2026-08-07 15:30 · designer · design complete → docs/design/T-016.md (composite-FK tenancy, 3-layer append-only receipt, target-by-arity); stage → build
undefined · builder · build complete → 14 forward-only migrations + @db (config/errors/pool/migrate/schema); typecheck green; no live Postgres available here, so the DDL is unexecuted — tester must run it; stage → test
undefined · tester · 171 tests across 5 files (131 always-on, 40 DATABASE_URL-gated and SKIPPED — no Postgres here, ADR-008); 2 FAIL: messages_thread_fk and offers_thread_fk omit deal_id, so a message/offer can name one deal while pointing at a thread of another (dealer_threads_account_deal_id_uk exists for exactly this and is referenced by nothing); stage → validate
