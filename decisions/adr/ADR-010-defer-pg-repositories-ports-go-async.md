# ADR-010: Defer the Postgres repositories (T-017); the comms ports go async when they land

- **Date:** 2026-08-08
- **Author:** chief-architect (session role)
- **Status:** accepted
- **Trigger:** T-017's designer produced a complete design and then correctly declared itself blocked. The block is real and structural, not a mistake.

## The problem
Epic 1's comms ports are **synchronous** — `CommsStore.getDeal()` returns `Deal | undefined`, `RawPayloadStore.markProcessed()` returns `'appended' | 'duplicate'`. They were written against an in-memory store, where synchronous is natural. Postgres is asynchronous, and no synchronous Postgres client exists in the approved dependency set. T-017's acceptance criteria forbid changing a port signature, so the designer's only remaining path was an asynchronous hydrate-then-serve unit of work: pre-load a working set, answer port calls synchronously from it, journal mutations, and flush on commit. That design is sound and it is genuinely clever, but it buys signature preservation with a permanent layer of complexity and an acknowledged divergence window between the in-session verdict and durable truth.

## Decision
**Defer T-017 out of Epic 2.** When Postgres repositories are actually needed, the fix is to **make the comms ports asynchronous** (return `Promise<...>`) rather than to hide asynchrony behind a unit of work. A store port that can never be backed by a real database is the wrong abstraction; the synchronous shape was an artifact of the in-memory implementation, not a considered contract.

## Why deferring is safe
ADR-008 already makes the **in-memory store the default** and Postgres opt-in. Nothing in the working proof of concept depends on T-017: the API runs, the war room can be built, and the whole product demonstrates end-to-end without it. T-016 landed the schema, so the database design is captured and reviewed; only the binding layer waits.

## Why not just accept the unit-of-work design
It would ship a subtle concurrency story into the foundation to preserve a signature that is itself the defect. Making the ports async is a mechanical, reviewable change to `services/comms` and its callers, and it leaves an abstraction that is honest about what a database is. Paying that cost once, deliberately, beats routing around it forever.

## Consequences
- T-017 is marked **deferred**, not failed. `docs/design/T-017.md` is retained — its analysis of the mismatch is the input to the async-port task.
- A future epic carries: (1) make comms ports async, (2) update `services/comms` and its consumers, (3) implement Postgres repositories against the async ports, (4) point the API at them when `DATABASE_URL` is set.
- Epic 2 publishes with T-016's schema and no repository binding. The PR must say so plainly rather than implying Postgres is wired.
- Recorded as a known limitation, not a hidden gap.
