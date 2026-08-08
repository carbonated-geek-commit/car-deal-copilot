---
id: T-015
title: Epic-2 workspace + dependency baseline (db, store-pg, object-store, api)
stage: test
owner_agent: builder
status: in_progress
depends_on: []
file_ownership:
  - "package.json"
  - "package-lock.json"
  - "tsconfig.base.json"
  - "vitest.workspace.ts"
  - "packages/db/package.json"
  - "packages/db/tsconfig.json"
  - "packages/store-pg/package.json"
  - "packages/store-pg/tsconfig.json"
  - "packages/object-store/package.json"
  - "packages/object-store/tsconfig.json"
  - "services/api/package.json"
  - "services/api/tsconfig.json"
spec_refs:
  - "specs/00-shared-core-architecture.md#core-domain-model"
  - "specs/00-shared-core-architecture.md#stack-opinionated--shared-defaults"
  - "specs/00-shared-core-architecture.md#async-backbone-shared"
  - "decisions/adr/ADR-001-backend-language-node-ts.md"
  - "decisions/adr/ADR-003-npm-workspaces-no-pnpm.md"
  - "decisions/adr/ADR-004-package-naming-and-lockfile.md"
mock_only: false
---

## Objective

The monorepo has room for Epic 2 and exactly one place where dependencies enter. Four new workspace members are registered and scaffolded to manifest level only — `packages/db` (schema + migrations + connection), `packages/store-pg` (Postgres implementations of the comms ports), `packages/object-store` (S3-compatible adapter), and `services/api` (the HTTP service) — with `@deal-copilot/*` names, bare TS path aliases, and their tsconfigs. This task also adds the **entire** Epic-2 runtime dependency set in one pass and regenerates the lockfile, so no later Epic-2 task touches root config or `package-lock.json`. It owns manifests only; every `src/`, `test/`, and `migrations/` subtree belongs to a later task.

## Acceptance criteria

1. `packages/db`, `packages/store-pg`, `packages/object-store`, and `services/api` are registered as workspace members under the existing npm-workspaces globs; no `pnpm-workspace.yaml` is introduced — cites decisions/adr/ADR-003-npm-workspaces-no-pnpm.md "Decision" ("The monorepo uses **npm workspaces** ... the workspace declaration lives in root `package.json`").
2. Each new package is named `@deal-copilot/<name>` and is reachable through a bare TS path alias in `tsconfig.base.json`, consistent with the existing alias convention — cites decisions/adr/ADR-004-package-naming-and-lockfile.md "Decision" §1 ("npm package names use the `@deal-copilot/<name>` scope ... Import aliases ... remain the bare forms").
3. The Epic-2 runtime dependency set is added here and nowhere else, and consists only of client libraries for integrations already on the approved list — a Postgres client, a migration runner, an S3-compatible object-store client, an HTTP server framework, and a request-validation library — cites specs/00-shared-core-architecture.md "Core domain model" (Store: "Postgres for the relational core ... object store (S3 or equiv.)") and specs/00 "Stack (opinionated — shared defaults)" ("**Backend:** Python (FastAPI) or **Node/TS** ... **DB:** Postgres + S3").
4. No dependency is added for an integration that is not on the approved list, and no managed-queue client is wired in this epic — the in-memory queue remains — cites specs/00-shared-core-architecture.md "Async backbone (shared)" (the bus is named but its provider is left open) and decisions/adr/ADR-001-backend-language-node-ts.md.
5. `package-lock.json` is regenerated deterministically and remains a root artifact modified only by this task — cites decisions/adr/ADR-004-package-naming-and-lockfile.md "Decision" §2 ("`package-lock.json` is a ... root artifact ... No other task may modify it.").
6. Root typecheck and test scripts cover the four new members alongside the existing ones, on the one shared toolchain — cites decisions/adr/ADR-001-backend-language-node-ts.md "Consequences" (monorepo layout, "Test tooling: vitest ... one toolchain") and decisions/adr/ADR-003-npm-workspaces-no-pnpm.md "Consequences".
7. The repo installs, typechecks, and runs its existing test suite green with the four new members present and empty (no `src/` files created by this task).

## Notes / constraints

- **This task exists to make the file-ownership rule satisfiable.** Root config and the lockfile are a single shared resource; concentrating them in one early task lets every other Epic-2 task run without contending for them. A later task that discovers it needs a new dependency **stops and messages the lead** — it does not edit root config.
- **ADR duty:** the specific library chosen for each of the five slots (pg client, migration runner, S3 client, HTTP framework, validator) is a chief-level choice among alternates and must be logged as an ADR before dependent work proceeds (CLAUDE.md "ADR duty"). None of them may be a new *service* or carry spend — they are libraries for integrations already approved.
- Do **not** create `packages/db/src`, `packages/db/migrations`, `packages/store-pg/src`, `packages/object-store/src`, or `services/api/src` here. Those subtrees are owned by T-016, T-017, T-018, T-019, T-020 respectively.
- `depends_on: []` — this task is independent of the Half-A migration and can run concurrently with T-010..T-014; its ownership set is disjoint from all of them.
- Do not touch protected paths: `CLAUDE.md`, `thesis.md`, `specs/**`, `.claude/**`.

## Log

<!-- append-only; one line per event: YYYY-MM-DD HH:MM · agent · event -->
2026-08-07 14:00 · planner · task created (Epic 2 Half B: persistence & API spine)
2026-08-07 15:30 · designer · design complete → docs/design/T-015.md; stage design → build; deviations D2 (fourth alias @comms — required or T-017/T-018/T-019 have no legal import path) and D5 (empty TS project is a tsc error; scripts-only ownership amendment requested for T-016..T-019) flagged to lead
2026-08-07 20:38 · builder · build complete; stage build → test. 8 manifests/tsconfigs created (no src/test/migrations); alias map 8 → 12 in both tsconfig.base.json and vitest.workspace.ts; root typecheck chain widened per D5. One root npm install: pg 8.22.0, @types/pg 8.21.0, @aws-sdk/client-s3 3.1106.0, fastify 5.11.2, zod 4.4.3 — ADR-008's five slots exactly, nothing else; second install byte-identical lockfile. @types/node reached transitively (26.2.0) so the §8-item-3 contingency did not fire. NEW BLOCKER for lead: packages/core/test/spine-invariants.test.ts asserts exactly eight aliases (2 failures) — foreign file, not edited; its owner must widen the expectation to the twelve of design §3.3. Pre-existing red unrelated to T-015 (T-011..T-014 Half-A migration still in flight): tsc fails in packages/core (tests), packages/adapters/valuation, packages/adapters/nhtsa, services/comms; 3 further test failures in packages/core + packages/flag-engine.
2026-08-07 · chief · D2/D5 ratified via ADR-009 (@comms alias = 12-entry map; typecheck script owner-editable). Blocker was stale: T-010 made the alias parity assertion count-generic (34569ac) and root config + manifests + deps all landed. T-015 work verified complete in tree.
