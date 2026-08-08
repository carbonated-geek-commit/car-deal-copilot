# ADR-009: `@comms` alias, and per-package `typecheck` scripts are owner-editable

- **Date:** 2026-08-07
- **Author:** chief-architect (session role)
- **Status:** accepted
- **Trigger:** T-015's designer/builder raised two deviations (D2, D5) and correctly stopped rather than assuming ratification.

## Decision

**1. A fourth alias, `@comms` → `services/comms/src/index.ts`, is ratified.** The task brief named three new aliases (`@db`, `@store-pg`, `@object-store`); a fourth is required, not cosmetic. `CommsStore`, `RawPayloadStore`, and `EventQueue` are declared in `services/comms/src/ports.ts` and re-exported from that service's index. T-017 must implement those ports, T-018 must name `RawPayloadStore`, and T-019 must import `createCommsService` / `InMemoryQueue` / `InMemoryCommsStore`. None of those tasks may edit root config, and npm-graph resolution is unavailable because `services/comms/package.json` declares no `exports`. Without `@comms` the only path left is `../../../services/comms/src/index.js`, which breaks the bare-alias rule that keeps deep imports impossible by construction (ADR-001 single-definition, T-001 design §3.3). The alias map is now **12 entries**, and the tsconfig ↔ vitest parity rule still binds entry-for-entry.

**2. T-016, T-017, T-018, and T-019 may each add a `"typecheck": "tsc -p . --noEmit"` script to their OWN `package.json`.** This is a narrow, explicit amendment to their `file_ownership`, limited to the `scripts` field of their own manifest.

**This is not a relaxation of the dependency rule.** Any change to `dependencies` or `devDependencies` in any manifest remains **T-015-only**, and adding an unlisted package remains an escalation to Corban. A reviewer seeing a dependency edit outside T-015 must still reject it.

## Spec basis
`CLAUDE.md` → file-ownership rule (the chief may re-scope tasks; every re-scope is logged). ADR-001 (single definition, no parallel types), ADR-003 (npm workspaces), ADR-008 (library set).

## Rationale for #2
An empty TypeScript project is a hard error (`TS18003`), so a package cannot carry a working `typecheck` script until its first source file exists — which happens inside the owning task, after T-015 has finished. Forcing that one line back through T-015 would mean either a root-config edit late in the epic or permanently uncovered typechecking. The line is mechanical and carries no dependency or version decision.

## Consequences
- The alias contract is 12 entries; `tsconfig.base.json` and `vitest.workspace.ts` must remain entry-for-entry identical (the parity test enforces this generically, by count, not against a hard-coded number).
- Every new package gets standalone typecheck coverage with no further root edits.
- The import-direction law stands: `@core` ← everything; `@comms` ← store-pg and api; `@db`/`@object-store` ← store-pg and api; `services/api` is the composition root and is imported by nothing.
