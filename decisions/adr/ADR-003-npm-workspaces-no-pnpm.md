# ADR-003: npm workspaces; no pnpm-workspace.yaml

- **Date:** 2026-08-07
- **Author:** chief-architect (session role)
- **Status:** accepted
- **Trigger:** T-001's planner frontmatter listed `pnpm-workspace.yaml`, but pnpm is not installed in the build environment and the orchestration mandate is npm workspaces. The T-001 designer flagged the deviation (design call D1, docs/design/T-001.md §0); chief resolves it here so the validator has a citable decision.

## Decision
The monorepo uses **npm workspaces** (Node 24 / npm 11). No `pnpm-workspace.yaml` exists; the workspace declaration lives in root `package.json` (`workspaces` globs covering `packages/*`, `packages/adapters/*`, `services/*`). T-001's `file_ownership` is amended accordingly (chief re-scope, logged in the task file).

## Spec basis
`specs/00-shared-core-architecture.md` → "Stack" names no package manager; ADR-001 fixed Node/TS. Package-manager choice is tooling within chief authority (choosing among alternates).

## Alternatives considered
- **pnpm** — not installed in the build environment; adds a toolchain dependency for no Epic-1 benefit.

## Consequences
- Root `package.json` is the single workspace manifest; later tasks never edit root config files (aliases are predefined by T-001 per its design doc).
- Any future switch to pnpm requires a superseding ADR.
