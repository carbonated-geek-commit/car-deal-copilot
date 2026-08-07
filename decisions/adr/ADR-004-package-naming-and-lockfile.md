# ADR-004: npm package naming (@deal-copilot/*) and root lockfile ownership

- **Date:** 2026-08-07
- **Author:** chief-architect (session role)
- **Status:** accepted
- **Trigger:** Two verifier findings on T-001 escalated by the fixer as chief-level: (1) `package-lock.json` was committed by the T-001 builder but matched no ownership glob; (2) the core package marker is named `@deal-copilot/core` where the design doc wrote `@core` — npm rejects bare `@core` (EINVALIDPACKAGENAME: scoped names must be `@scope/name`).

## Decision
1. **npm package names use the `@deal-copilot/<name>` scope** (e.g. `@deal-copilot/core`). Import aliases in `tsconfig.base.json` / `vitest.workspace.ts` remain the bare forms (`@core`, `@flag-engine`, `@adapters/*`, `@offer-extraction`, `@receipt`) — aliases never depended on npm package names. The builder's forced rename is ratified.
2. **`package-lock.json` is a T-001-owned root artifact.** It is the direct product of the sanctioned one-time root install; leaving it untracked would break install determinism. T-001 `file_ownership` is amended to include it (chief re-scope, logged in the task file). No other task may modify it.

## Spec basis
ADR-001 "Consequences" (monorepo layout, one toolchain) and ADR-003 (npm workspaces). Mechanical consequences of the chosen toolchain — chief authority.

## Alternatives considered
- Unscoped names (`deal-copilot-core`) — loses the org-scope convention for no benefit.
- Leaving the lockfile untracked — non-deterministic installs; worse.

## Consequences
- Downstream package.json markers follow `@deal-copilot/<name>`; imports keep using the bare aliases.
- Verifiers treat the lockfile and scoped names as ratified, citable to this ADR.
