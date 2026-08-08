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
2026-08-07 21:00 · designer · re-verification pass; docs/design/T-015.md amended (§0 D2/D5 marked ratified per ADR-009, §8 rewritten as final disposition, new §9 verification record). MEASURED: alias parity 12/12 entry-for-entry identical across tsconfig.base.json and vitest.workspace.ts; all four members registered as workspace entries in package-lock.json under the unchanged globs (no pnpm-workspace.yaml); deps resolve at pg 8.22.0, @types/pg 8.21.0, @aws-sdk/client-s3 3.1106.0, fastify 5.11.2, zod 4.4.3 (ADR-008's five slots, nothing else; root devDeps still typescript+vitest only); packages/core green 173/173 incl. spine-invariants (28) and the AC-17 typecheck gate; each new member holds package.json+tsconfig.json only (no src/test/migrations). Builder's alias-count blocker RETRACTED as stale — packages/core not touched. Only open item is D7 (how the API process starts), handed to T-019 by design. Stage left at test (build landed in 73b145f..5e90c36; regressing to build would re-run a completed build). Nothing blocking.
2026-08-07 21:05 · builder · verification pass (no code change required — the build already landed in 73b145f..5e90c36; nothing was missing). MEASURED against the tree: (1) alias parity — tsconfig.base.json compilerOptions.paths and vitest.workspace.ts alias are BOTH 12 entries, identical key-for-key, target-for-target, AND position-for-position (@core, @flag-engine, @adapters/valuation, @adapters/nhtsa, @adapters/vehicle-history, @adapters/credit-prequal, @offer-extraction, @receipt, @comms, @db, @store-pg, @object-store) — ADR-009 §1 map exactly. (2) Workspace registration — `npm query .workspace` lists 13 members including @deal-copilot/db, @deal-copilot/store-pg, @deal-copilot/object-store, @deal-copilot/api; root `workspaces` globs unchanged (D1 held); no pnpm-workspace.yaml; all four present as workspace entries in package-lock.json (lockfileVersion 3). (3) Deps resolve from each owning member via createRequire: pg 8.22.0 (db, store-pg), @types/pg 8.21.0, @aws-sdk/client-s3 3.1106.0 (object-store), fastify 5.11.2 + zod 4.4.3 (api) — ADR-008's five slots, nothing else; root devDependencies still typescript+vitest only (D3 held). (4) Lockfile deterministic — `npm install --package-lock-only` produced a zero-byte diff. (5) tsconfig extends chain verified: all four new projects emit ONLY TS18003 (no inputs), never TS5083 — confirmed against a deliberate bad-extends control which emits both, so `../../tsconfig.base.json` resolves in all four. (6) `npm run typecheck --workspaces --if-present` exits 0 (no-op today, becomes coverage on the ADR-009 §2 per-package script). (7) packages/core green 173/173 across 7 files incl. spine-invariants (28) and the AC-17 standalone typecheck gate — the prior alias-count blocker is confirmed STALE and packages/core was NOT touched. (8) Each new member holds package.json + tsconfig.json only; no src/, test/, migrations/, or .gitkeep. Out of scope and not judged: packages/adapters/*, services/comms, and the root typecheck chain are red from the deliberate T-010 spine break pending T-011..T-014. Stage stays test. Nothing blocking.
