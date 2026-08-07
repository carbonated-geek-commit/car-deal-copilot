#!/usr/bin/env python3
"""TaskCompleted hook: a task may not close over a dirty tree.

Invariant served: "a crash costs at most the last uncommitted increment;
it can never cost completed work or pipeline state."

- Dirty git tree (per .gitignore) -> exit 2: completion refused, teammate is
  told to commit first. This makes commit-before-complete structural.
- Clean tree -> snapshot a checkpoint (scripts/checkpoint.sh), exit 0.
- Not a git repo -> allow with a warning (gate is only meaningful in-repo).
"""
import json, os, subprocess, sys

def main() -> int:
    root = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    try:
        payload = json.load(sys.stdin)
    except Exception:
        payload = {}
    inside = subprocess.run(
        ["git", "-C", root, "rev-parse", "--is-inside-work-tree"],
        capture_output=True, text=True,
    )
    if inside.returncode != 0:
        print("task_completed_gate: not a git repo; gate skipped.", file=sys.stderr)
        return 0
    status = subprocess.run(
        ["git", "-C", root, "status", "--porcelain"],
        capture_output=True, text=True,
    )
    dirty = [l for l in status.stdout.splitlines() if l.strip()]
    if dirty:
        subject = payload.get("task_subject", "this task")
        print(
            f"COMPLETION REFUSED for '{subject}': working tree has "
            f"{len(dirty)} uncommitted change(s). Commit your work first "
            f"(wip commits referencing the task id are fine), then mark complete. "
            f"Crash-durability rule: nothing counts as done until it is in git.",
            file=sys.stderr,
        )
        return 2
    subprocess.run(["bash", os.path.join(root, "scripts", "checkpoint.sh")],
                   capture_output=True, text=True)
    return 0

if __name__ == "__main__":
    sys.exit(main())
