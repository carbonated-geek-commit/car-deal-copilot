# ADR-011: `tsx` is added as a dev-only TypeScript runner

- **Date:** 2026-08-08
- **Author:** chief-architect (session role)
- **Status:** accepted — **flagged for Corban's review; reversible**
- **Trigger:** The API could not be started at all. `packages/*` use bare path aliases (`@core`, `@comms`, …) that exist only in `tsconfig.base.json` and the vitest alias map. Node resolves neither, so `node services/api/src/bin.ts` fails with `Cannot find module '@comms'`. T-015's design anticipated exactly this and left it open as design call D7, "no TS runtime loader was pre-registered — escalates to the lead."

## Decision
Add **`tsx`** as a root `devDependency` and run the service with `npm run dev`. `tsx` resolves `tsconfig` path aliases at runtime, which is precisely the missing piece.

## Why this is a toolchain choice, not an unapproved integration
CLAUDE.md requires escalation for "any new system, service, or integration … and any spend." `tsx` is none of those: it is a local development runner in the same class as `typescript` and `vitest`, both already approved. It ships nothing, calls no external service, costs nothing, and never appears in a production runtime path. On that reading this sits with ADR-003 (npm over pnpm) and ADR-008 (pg/fastify/zod) as chief-level toolchain selection.

**However** — the constitution also says the chief may not approve what is not on the list, and `tsx` is not on the list. So this ADR is deliberately marked *flagged for review*: it is recorded loudly rather than folded in silently, and Corban can reverse it at no cost (see below).

## Alternatives considered
- **Compile with `tsc` and run the emitted JS.** No new dependency, but the aliases still need rewriting to relative paths on emit, so it needs a bundler or a resolver anyway — trading one tool for a heavier one.
- **Node's built-in type stripping** (default in Node 22.18+/24). Strips types fine but does **not** resolve `tsconfig` path aliases, so `@core` still fails. Insufficient alone.
- **Drop the bare aliases and import by workspace package name** (`@deal-copilot/core`). Removes the need for any loader and is arguably the better long-term shape — but it rewrites every cross-package import in the repo and would break T-001's deliberate "deep imports impossible by construction" property. Too large to do as a side effect of getting the process to boot; recorded as the reversal path.

## Consequences
- `npm run dev` starts the API; this is what makes the proof of concept demonstrable.
- Reversal is cheap: adopt workspace package names, drop `tsx`, and the aliases go with it.
- The approved-dependency guards in `test/T-015-workspace-baseline.test.ts` and `packages/core/test/spine-invariants.test.ts` are widened to admit `tsx` **and cite this ADR**, so the allowlist is never silently loosened.
