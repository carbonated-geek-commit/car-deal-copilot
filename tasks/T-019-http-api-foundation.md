---
id: T-019
title: HTTP API service foundation — account context, validation, error envelope, authorization seam
stage: build
owner_agent: designer
status: in_progress
depends_on: [T-014, T-015, T-017, T-018]
file_ownership:
  - "services/api/src/**"
  - "services/api/test/**"
  - "services/api/package.json"   # scripts field ONLY, per ADR-009
spec_refs:
  - "specs/00-shared-core-architecture.md#stack-opinionated--shared-defaults"
  - "specs/00-shared-core-architecture.md#core-domain-model"
  - "specs/00-shared-core-architecture.md#comms-aggregation-layer-provider-agnostic--shared"
  - "specs/00-shared-core-architecture.md#dealership-data-tenancy"
  - "specs/01-consumer-product-spec.md#account-model-the-piece-we-locked"
  - "specs/01-consumer-product-spec.md#concierge-tier-consumer-only"
  - "specs/01-consumer-product-spec.md#credit-data-residency-resolved-2026-08-07"
  - "decisions/OPEN-QUESTIONS.md (Q3, Q4)"
  - "decisions/adr/ADR-001-backend-language-node-ts.md"
mock_only: false
---

## Objective

`services/api` is a Node/TS HTTP service that fronts the v0.5 spine. This task builds the foundation, not the routes: the server and its composition (Postgres-backed comms store, object-store adapter, comms service — all behind the ports they already declare), an account context resolved once at the edge and threaded into every repository call, a single deal-scoped authorization choke point that currently permits but is the only place E3 will need to touch, request validation that runs before any repository call, and one shared error envelope every endpoint reports through. Webhook endpoints ack immediately and enqueue. No auth provider is selected or wired.

## Acceptance criteria

1. A Node/TS HTTP service exists and is the only process-level entry point to the spine — cites specs/00-shared-core-architecture.md "Stack (opinionated — shared defaults)" ("**Backend:** Python (FastAPI) or Node/TS") and decisions/adr/ADR-001-backend-language-node-ts.md "Decision".
2. Every request resolves an account context at the edge, and every repository call made anywhere in the service is account-scoped — there is no code path that reaches the store without one — cites specs/01-consumer-product-spec.md "Account model" ("`Account` owns `Deals`") and specs/00-shared-core-architecture.md "Dealership data tenancy".
3. Deal-scoped authorization is a declared seam: every deal-addressed request passes through one choke point that today permits, so per-deal grants that expire and role-scoped views can be enforced there later without restructuring routes or repositories — cites specs/01-consumer-product-spec.md "Concierge tier" enforced controls 1 and 3 ("Role-scoped views ... credit detail is absent from the agent API surface"; "Per-deal grants that expire ... no standing access to any account") and decisions/OPEN-QUESTIONS.md Q4.
4. No authentication provider is selected, wired, or depended on in this epic; the alternates named in the spec remain unchosen — cites specs/00-shared-core-architecture.md "Stack (opinionated — shared defaults)" ("**Auth:** Auth0 / Clerk / Cognito" — named as alternates, not a choice).
5. Request validation rejects malformed or out-of-enum input before any repository call, against the spine's spec-fixed enums — cites specs/00-shared-core-architecture.md "Core domain model" (fixed enum sets for `path`, `status`, `channel`, `direction`, `author`, `condition`, `process_step`, `role`).
6. Every rejection and every error is reported through one shared error envelope defined once in the service; no endpoint defines its own error shape — cites decisions/adr/ADR-001-backend-language-node-ts.md "Decision" ("defined once ... and imported everywhere — no parallel type definitions").
7. Webhook endpoints ack immediately and enqueue; the API performs no extraction, valuation, or notification work inline on the request path — cites specs/00-shared-core-architecture.md "Comms aggregation layer (provider-agnostic — shared)" ("webhooks ack immediately, all heavy work ... runs on the event bus. Provider timeouts must never drop a dealer message.").
8. The service composes the Postgres-backed store and the object-store adapter behind the comms ports as they already exist; substituting infrastructure requires no change to the service's own code — cites specs/00-shared-core-architecture.md "Core domain model" (Store: "Postgres for the relational core ... object store (S3 or equiv.)").
9. The API surface exposes prequal summary values only (qualified rate, amounts); no field, route, or response type can carry raw credit data — cites specs/01-consumer-product-spec.md "Credit data residency" ("we store a provider token + prequal results (qualified APR, amounts) and nothing else ... Raw credit data never lands in our systems") and decisions/OPEN-QUESTIONS.md Q3.
10. `Dealership` records are readable globally while `DealershipContact` records are readable only within the owning account, enforced on the response path as well as in the query — cites specs/00-shared-core-architecture.md "Dealership data tenancy".
11. No response type carries an audio reference or a transcript field — cites specs/00-shared-core-architecture.md "Core domain model" (Store: "No audio is stored") and specs/00 "Comms aggregation layer" ("No audio is captured and no transcription runs").
12. The service starts, serves, and passes its foundation tests against a real Postgres and a local object-store endpoint.

## Notes / constraints

- **This task must not create `services/api/src/routes/**` or `services/api/test/routes/**`.** That subtree is owned by T-020, which depends on this task; the nested ownership is legal only because it is sequenced.
- Manifests (`services/api/package.json`, `tsconfig.json`) belong to T-015; a missing dependency is an escalation to the lead, not a manifest edit.
- **Auth is E3.** The deliverable here is the *shape* that lets authorization drop in: one account context, one authorization choke point, one scoped repository interface. Do not implement sessions, tokens, roles, or grants.
- The managed queue stays unwired in this epic — the service composes the existing in-memory queue behind the `EventQueue` port.
- Do not touch protected paths: `CLAUDE.md`, `thesis.md`, `specs/**`, `.claude/**`.

## Log

<!-- append-only; one line per event: YYYY-MM-DD HH:MM · agent · event -->
2026-08-07 14:00 · planner · task created (Epic 2 Half B: persistence & API spine)
undefined · designer · design published (docs/design/T-019.md); stage design → build. Shape: one account context resolved at the edge behind an AccountContextResolver port (E2 impl is `poc-header`, explicitly NOT auth, so AC-4 holds and E3 swaps one file); one deal-scoped choke point where `DealHandle` carries a module-private unique symbol so every store-touching signature takes the handle instead of a deal_id and the unscoped path does not compile, backed by a boot-time onRoute audit that fails startup for a :deal_id route missing the gate or validation (so T-020's routes are covered without editing them); zod validation at preValidation built from @core's frozen vocabulary arrays, ordered 401 → 400 → gate → handler; one error envelope that also overwrites Fastify's own 400/404/413/415/500 bodies; not-owned returns 404 not 403 so a deal id is not an existence oracle; webhook plane in its own plugin scope with no context, no gate and therefore no store, status taken verbatim from WebhookIngestOutcome. ADR-008 posture: storage plan computed once, no branch exists from a Postgres failure to in-memory, partial object-store config aborts startup. Notes to lead, none blocking: (1) @core exports no DEAL_PATHS/DEAL_STATUSES — declared locally with a compile-time exhaustiveness guard, recommend a @core-owning task add them; (2) webhook + health endpoints live in src/webhooks and src/http, not src/routes (T-020's subtree) — AC-7 is mine, the plane is genuinely different; (3) form-encoded webhooks unsupported (JSON only) because @fastify/formbody is a T-015-only dependency edit — a real gap for the epic that wires Twilio/SES; (4) Postgres-configured-without-object-store is allowed with a warn and reported as raw_payload_durability:"volatile" — ADR-008 gives no authority to require the pair, recommend the lead decide whether it should abort; (5) @store-pg is designed but not built (T-017 is status:blocked on E1) — every signature used is taken verbatim from docs/design/T-017.md §2 and a divergence is a stop, not a shim; in-memory mode has no such dependency. Verified at design time (probe files created, compiled, deleted, nothing committed): fastify + zod + node:process + node:crypto + structuredClone/TextEncoder/setTimeout all typecheck under `npx tsc -p services/api --noEmit` with tsconfig.base's `types: []`, so this service needs NO node-shim.d.ts — T-018's shim rationale inverts here. Not blocked.
