# Task Schema (binding for planner and all stage agents)

One file per task: `tasks/T-<nnn>-<slug>.md`. Frontmatter + body:

```markdown
---
id: T-014
title: Valuation adapter — KBB (mock-only)
stage: build                # design | build | test | qa | validate | code-review | fix | publish
owner_agent: builder        # matches a .claude/agents name
status: pending             # pending | in_progress | blocked | done
depends_on: [T-001, T-009]  # task ids; empty list if none
file_ownership:
  - "src/adapters/valuation/kbb/**"
  - "tests/adapters/valuation/kbb/**"
spec_refs:
  - "specs/00-shared-core-architecture.md#valuation"
mock_only: true             # true if it touches a mock-only integration (see CLAUDE.md)
---

## Objective
One paragraph: what exists when this task is done.

## Acceptance criteria
1. <criterion> — cites <spec file + heading>
2. ...

## Notes / constraints
Anything the stage agent must know (design doc link, fixtures, invariant touchpoints).

## Log
<!-- append-only; one line per event: YYYY-MM-DD HH:MM · agent · event -->
```

## Rules
- `file_ownership` uses globs; **no two concurrently-runnable tasks may overlap** — overlap forces a `depends_on` edge (teammates are not worktree-isolated).
- Every acceptance criterion cites a spec section or ADR. Uncitable criterion = scope invention = flag to lead.
- `depends_on` must form a DAG; shared-core contract tasks have no dependencies and everything downstream depends on them.
- Stage agents update `status` on claim/completion; the lead reconciles with the team task list.
- Every stage agent appends one line to the task's `## Log` on claim, hand-off, and completion — this is the curated per-task record that survives crashes (raw session transcripts under `~/.claude/projects/` are the uncurated one).
