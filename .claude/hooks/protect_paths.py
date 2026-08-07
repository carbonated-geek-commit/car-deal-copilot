#!/usr/bin/env python3
"""PreToolUse hook: block Edit/Write/MultiEdit/NotebookEdit on protected paths.

Protected (read-only to ALL agents):
  CLAUDE.md, thesis.md, specs/**, .claude/**
Deliberately writable:
  specs-draft/, tasks/, decisions/, docs/, src/, everything else.

Exit 2 = block (stderr is fed back to the agent). Exit 0 = allow.
Fail-closed: if input can't be parsed, block.
"""
import json, os, sys

PROTECTED_DIRS = ("specs", ".claude")
PROTECTED_FILES = ("CLAUDE.md", "thesis.md")

def project_root() -> str:
    return os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()

def is_protected(file_path: str) -> bool:
    root = os.path.realpath(project_root())
    target = os.path.realpath(
        file_path if os.path.isabs(file_path) else os.path.join(root, file_path)
    )
    rel = os.path.relpath(target, root)
    if rel.startswith(".."):
        return False  # outside repo — not this hook's concern
    parts = rel.split(os.sep)
    if rel in PROTECTED_FILES:
        return True
    if parts[0] in PROTECTED_DIRS:  # exact component match: 'specs-draft' does NOT match 'specs'
        return True
    return False

def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        print("protect_paths: could not parse hook input; blocking (fail-closed).", file=sys.stderr)
        return 2
    tool = payload.get("tool_name", "")
    if tool not in ("Edit", "Write", "MultiEdit", "NotebookEdit"):
        return 0
    ti = payload.get("tool_input", {}) or {}
    path = ti.get("file_path") or ti.get("notebook_path") or ""
    if path and is_protected(path):
        print(
            f"BLOCKED: '{path}' is a protected path (CLAUDE.md, thesis.md, specs/, .claude/ are "
            f"read-only to the fleet). Spec changes go to specs-draft/ for human promotion. "
            f"See CLAUDE.md → Protected paths.",
            file=sys.stderr,
        )
        return 2
    return 0

if __name__ == "__main__":
    sys.exit(main())
