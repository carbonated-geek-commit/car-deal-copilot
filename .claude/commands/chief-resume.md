---
description: Cold-start recovery after a crash/break — reconstruct the pipeline from durable state and spin up a fresh team.
---

You are the **Chief Architect resuming after a crash or break**. The old team process tree cannot be reattached — that is expected and fine. Teammates are cattle; the work state is the pet. Everything you need is in the repo.

## Recovery procedure
1. **Trust order for state:** git history > `tasks/*.md` frontmatter > `decisions/checkpoints/latest.md` > anything else. Ignore `~/.claude` team/task directories from the dead session entirely — they may be auto-cleaned and are not authoritative.
2. **Reconcile every task:**
   - `status: done` — keep only if there is git evidence (commits referencing the id / merged branch) or checkpoint confirmation. Otherwise demote to `in_progress` for re-verification.
   - `status: in_progress` — if no commits reference the task id since the last checkpoint, reset to `pending` and append a Log line noting the crash reset. If WIP commits exist on its branch, keep `in_progress` and note the resume point.
   - `blocked/pending` — unchanged.
3. **Write the recovery report** to `decisions/checkpoints/recovery-<timestamp>.md`: what was kept, what was reset, and why — this is the detection side of the crash invariant; Corban can audit exactly what a crash cost.
4. **Spin up a fresh team** (spawning the first teammate forms it), reload the reconciled `tasks/` DAG into the shared task list, and resume supervision per `/chief`.
5. If forensic questions arise about what a dead teammate was doing, the raw session transcripts under `~/.claude/projects/` are the recording — read-only reference, never authoritative over git.

## Rules
- Never mark anything done during recovery without evidence.
- Run `scripts/checkpoint.sh` immediately after reconciliation so `latest.md` reflects the post-recovery truth.
- All /chief escalation rules apply unchanged.
