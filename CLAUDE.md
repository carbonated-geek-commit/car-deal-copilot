# Fleet Constitution — Deal Co-Pilot

Every agent (lead, teammate, subagent) operating in this repo is bound by this file. It is read-only to the fleet.

## Authority order

1. `thesis.md` — the business intent. Overrides everything.
2. `specs/` — the three product specs (shared core, consumer, B2B).
3. `decisions/adr/` — logged architecture decisions interpreting the specs.
4. `tasks/` — the work plan derived from the specs.
5. `docs/design/` — per-task design docs.

If two sources conflict, the higher one wins and the conflict is **escalated to the Chief Architect**, who resolves-and-logs (if interpretive) or escalates to Corban (if it requires changing a protected file).

## Protected paths (structurally enforced by PreToolUse hook)

`CLAUDE.md`, `thesis.md`, `specs/**`, and `.claude/**` are **read-only to all agents**. The hook blocks Edit/Write on them.

- Spec changes are drafted to `specs-draft/` and enter `specs/` only via a **human-approved commit by Corban**.
- No agent may modify agent definitions, hooks, settings, or this constitution.

## Escalation boundary

**The Chief Architect may, without Corban:**
- Resolve ambiguity *within* the specs — every such call MUST be logged as an ADR in `decisions/adr/` (see ADR duty below).
- Sequence, assign, split, or re-scope tasks; run fix loops; accept/reject stage outputs.
- Choose among options the specs explicitly leave open as named alternates (e.g., pick one of SES/SendGrid/Postmark; one of Auth0/Clerk/Cognito) — logged as an ADR.

**The Chief Architect MUST escalate to Corban (hard line, confirmed):**
- **Any new system, service, or integration not on the approved list below — and any spend.** No exceptions.
- Anything that requires editing a protected path (spec change, thesis change).
- Any thesis-gate ESCALATE verdict.
- Any conflict between spec and thesis that can't be resolved by the authority order without reinterpretation of the thesis.

## Approved integrations

**Build and wire now (no escalation needed):**
Postgres · S3-compatible object store · Stripe · Twilio · one of {SES+Lambda, SendGrid, Postmark} · one of {Auth0, Clerk, Cognito} · NHTSA vPIC + Recall API · Next.js · React Native · FastAPI (Python) or Node/TS · managed queue (SQS/SNS or equivalent).

**Approved targets — MOCK-ONLY until Corban signs contracts/credentials:**
KBB · J.D. Power (NADA) · Black Book · Manheim MMR · Carfax · AutoCheck · credit providers (Array / Plaid / MeasureOne / bureau reseller) · lender marketplace APIs.

Agents build adapters against the internal interface with mocks. **Live credentials for these do not exist in this repo; that absence is the structural enforcement.** Requesting, purchasing, or wiring live access = escalate to Corban.

**Everything else:** not approved. Escalate.

## ADR duty (drift trip-wire)

Any interpretive call — resolving spec ambiguity, choosing among alternates, re-scoping a task — gets an ADR in `decisions/adr/` **before** dependent work proceeds. An interpretation that never touched a file is invisible; the ADR makes it visible. No ADR, no downstream work.

## File-ownership rule (mandatory — teams are not worktree-isolated)

Every task declares `file_ownership` (glob list). **No two tasks that can run concurrently may overlap in ownership**; overlapping tasks must be sequenced via `depends_on`. A builder/fixer touching a path outside its task's ownership must stop and message the lead.

## Pipeline

`design → build → test → qa → validate → code-review → fix (loop) → publish`

A task advances only when its current stage's owner reports green to the lead. `fix` returns work to the stage that failed. `publish` is PR-only (never direct push to main) and gated on: all stages green, validator pass, zero protected-path diffs.

## Reporting

Workers report to the **Chief Architect (team lead)** — not to Corban. Corban interacts with the system at: the architect interview, gate escalations, unapproved-integration/spend requests, and spec promotion. Durable state lives in files (`tasks/`, `decisions/`), not in any session's context.

## System invariants (prevention / detection)

1. **Fleet cannot mutate its constitution.** Prevented: PreToolUse hook on protected paths. Detected: any diff touching them in review → automatic reject.
2. **No unapproved integration or spend.** Prevented: credential absence for mock-only + unlisted services. Detected: code-reviewer flags any new external dependency, SDK, endpoint, or credential reference not on the approved list.
3. **No silent interpretive drift.** Prevented: ADR duty blocks dependent work. Detected: validator cross-checks implementations against specs + ADRs; an implementation choice with no spec line and no ADR is a finding.
