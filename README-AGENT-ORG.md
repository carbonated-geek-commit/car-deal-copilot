# Agent Org — How to Run This Repo

An agent org chart with a pipeline and gates. You (Corban) sit at exactly four contact points: the architect interview, gate escalations, unapproved-integration/spend approvals, and spec promotion (+ PR merges unless you delegate them). Everything else reports to the Chief Architect.

## The org

```
Corban
 │ interview                    escalations only
 ▼                                   ▲
/architect  ──►  thesis-gate  ──►  /chief (team lead, agent team)
(interactive)    PASS/ESCALATE      │ assigns via shared task list + mailbox
                     │              ▼
                 planner ──► tasks/*.md ──► designer → builder → tester → qa
                                            → validator → code-reviewer → fixer ⟲ → publisher (PR only)
```

Split-gate design: **thesis-gate can only PASS/ESCALATE** (it writes nothing but its verdict file) and **planner only runs on a recorded PASS** — the gate has no task-writing incentive to rubber-stamp.

## Run sequence

**Phase 0 — Architecture interview (you present).**
```
git init && git add -A && git commit -m "kit"   # first: make the kit the repo's first commit (crash durability rides on git)
claude          # in the repo root
/architect
```
It works through `decisions/OPEN-QUESTIONS.md` one question at a time, records your answers, drafts spec amendments to `specs-draft/`. **Promote drafts yourself:** review, apply to `specs/`, commit. Agents cannot write `specs/` — the hook blocks them.

**Phase 1 — Gate.** Ask the session to run the `thesis-gate` agent on the promoted specs. PASS verdict lands in `decisions/gate/`. ESCALATE comes to you.

**Phase 2 — Plan.** Run the `planner` agent → `tasks/*.md` DAG. Skim it — this is your last cheap look before tokens start burning.

**Phase 3 — Execute (you absent).**
```
claude
/chief
```
Chief verifies preconditions, creates the agent team, loads the task list, supervises. Optionally put the lead in delegate mode (Shift+Tab) so it can only coordinate, never implement.

## Monitoring (when you choose to look)
- **Ctrl+T** — shared task list: states, assignments, dependencies.
- **Shift+Up/Down** — cycle teammates; **Enter** to view a session; **Escape** to interrupt one.
- You *can* message a teammate directly — the design intends you not to need to.

## Crash durability & recovery (designed-in)
The experimental limitation is real but narrower than it sounds: a crash loses the **process tree** (you can't reattach teammates), not the record or the work. Raw session transcripts persist on disk under `~/.claude/projects/` regardless of crashes — the recording exists; only reattachment doesn't.

So the kit is built to a bounded-loss invariant: **a crash costs at most the last uncommitted increment; it can never cost completed work or pipeline state.**
- **Prevention (structural):** a `TaskCompleted` hook refuses to close any task over a dirty git tree — commit-before-complete is enforced with exit-2, not requested. On every clean completion the hook auto-snapshots `decisions/checkpoints/latest.md`; the Chief also checkpoints on assignment changes.
- **Recovery:** run `/chief-resume` in a fresh session. It reconciles every task against git evidence (unproven in-progress → reset to pending; done requires commits or checkpoint confirmation), writes a recovery report to `decisions/checkpoints/`, spins up a new team, and reloads the DAG. Teammates are cattle; the work state is the pet.
- **Detection:** the recovery report lists exactly what a crash cost, so the invariant is auditable, not assumed.
- Honest residual: a teammate's mid-task reasoning that never touched a file or commit is gone — bounded by the commit gate to less than one increment.

## Known limitations you accepted (experimental)
- **One team at a time; no nesting** (teammates can't spawn teams). Run epics sequentially.
- **Teammates inherit the lead's permissions at spawn**; adjust after, not during, creation.
- **No worktree isolation inside a team** → file-ownership partitioning in the task schema is the collision control. Non-negotiable.
- **Stale task states happen** — Chief nudges; you occasionally Ctrl+T.
- **Token burn:** a team runs ~7x a single session (per Anthropic's costs doc, in plan mode) — and cost scales with teammate count. Point mechanical roles (tester, fixer) at a cheaper model in their agent files if burn bites; keep the strongest model on chief/validator/reviewer.

## Invariants (enforced, not hoped)
1. **Fleet can't mutate its constitution** — PreToolUse hook blocks writes to `CLAUDE.md`, `thesis.md`, `specs/`, `.claude/`. Self-tested (7 cases) at kit build.
2. **No unapproved integration/spend** — approved list in CLAUDE.md; mock-only services have no live credentials in-repo (absence IS the enforcement); reviewer flags any new dependency.
3. **No silent interpretive drift** — every interpretive call needs an ADR before dependent work; validator treats un-ADR'd choices as findings.

## First epic recommendation
Shared-core contracts first (Phase-0 tasks, no parallelism), then fan the adapters out across the team. The planner is instructed accordingly.
