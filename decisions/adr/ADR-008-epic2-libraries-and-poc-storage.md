# ADR-008: Epic-2 library choices, and the PoC runs on in-memory storage by default

- **Date:** 2026-08-07
- **Author:** chief-architect (session role)
- **Status:** accepted
- **Trigger:** T-015 flagged that the Postgres client, migration runner, S3 client, HTTP framework, and validator are unnamed. All implement integrations already on CLAUDE.md's approved list (Postgres, S3-compatible object store, Node/TS), so choosing among them is chief authority — but the choice must be logged before dependent work.

## Decision

**Libraries** (all implement already-approved integrations; none is a new integration or a spend item):

| Need | Choice | Why |
|---|---|---|
| Postgres client | `pg` (node-postgres) | The de-facto standard driver; no ORM, so SQL stays explicit and the append-only receipt constraint is visible in the schema rather than hidden behind a model layer. |
| Migrations | Plain `.sql` files + a small in-repo runner | Zero dependency, fully auditable; migrations are the security surface for the tenancy split and append-only rules. |
| Object store | `@aws-sdk/client-s3` | S3-compatible, works against MinIO or any equivalent; no vendor lock beyond the approved integration. |
| HTTP framework | `fastify` | First-class TypeScript, schema-based validation at the route boundary, low overhead. |
| Validation | `zod` | TS-first; one schema yields both the runtime check and the static type, so the API contract cannot drift from the types. |

**Storage posture for the proof of concept:** the API **defaults to the in-memory store Epic 1 already built**, and uses Postgres/S3 when `DATABASE_URL` (and object-store config) are present.

## Spec basis
`specs/00-shared-core-architecture.md` → "Store" names Postgres + object store; ADR-001 fixes Node/TS. `CLAUDE.md` → approved integrations list.

## Rationale for the storage posture
Corban's instruction is a **working website**, and this is a proof of concept, not a live site. Requiring a running Postgres and an S3 endpoint before the site renders would make "working" depend on local infrastructure. The ports from Epic 1 (`CommsStore`, `RawPayloadStore`, `EventQueue`) already make the backing store a swap. So:

- The site runs end-to-end with **no external services at all** — this is what makes the PoC demonstrable.
- The Postgres and S3 implementations are still **built and specified per spec**, satisfying the "Store" requirement rather than deferring it.
- Repository tests that need a live database **skip when `DATABASE_URL` is unset** and run when it is set. A skipped test is reported as skipped, never as passed — silently green tests over an absent database would be a lie about coverage.

## Alternatives considered
- **Require Postgres for the PoC** — truer to production, but makes the deliverable undemonstrable without setup. Rejected for a PoC.
- **SQLite instead of Postgres** — would contradict specs/00 "Store" and need a spec amendment for no PoC benefit, since in-memory already covers the demo case.
- **An ORM (Prisma/Drizzle)** — hides the append-only and tenancy constraints that most need to be reviewable in raw SQL.

## Consequences
- Data does not persist across restarts in the default PoC mode; this must be stated plainly in the README rather than left for a user to discover.
- Every repository call is account-scoped in both implementations, so E3's authorization slots in without redesign.
- Swapping to Postgres is configuration, not a code change.
