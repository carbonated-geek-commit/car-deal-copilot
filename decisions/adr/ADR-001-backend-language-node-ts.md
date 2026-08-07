# ADR-001: Backend language is Node/TypeScript

- **Date:** 2026-08-07
- **Author:** chief-architect (session role)
- **Status:** accepted
- **Trigger:** Spec leaves the backend open as "Python (FastAPI) or Node/TS"; Corban explicitly delegated the choice to the chief per OPEN-QUESTIONS Q10. Planning cannot proceed without it (task file_ownership and test tooling depend on the language).

## Decision
The backend is **Node/TypeScript**. One language across the stack: Next.js (web), React Native (app), Node/TS services (backend). The shared spine (`Deal` / `DealerThread` / `Message` / `Offer`) is defined once as TypeScript types in a shared package and imported everywhere — no parallel type definitions.

## Spec basis
`specs/00-shared-core-architecture.md` → "Stack (opinionated — shared defaults)": names FastAPI (Python) or Node/TS as the approved alternates; both are on the CLAUDE.md approved list. This ADR selects among named alternates — within chief authority.

## Alternatives considered
- **FastAPI (Python)** — better if ML-heavy offer extraction dominated early; but extraction at launch is parseable with rules + LLM API calls from any language, and a two-language stack forfeits shared spine types across web/app/backend for a small team.

## Consequences
- Monorepo layout: `packages/core` (spine types + flag engine), `packages/adapters/*`, `services/api`, `apps/web`, `apps/mobile`.
- Test tooling: vitest (or jest) across all packages; one toolchain.
- All planner tasks assume TS; any future Python component would require a superseding ADR.
