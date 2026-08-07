#!/usr/bin/env bash
# Snapshot pipeline state into the repo (crash-durable). Called by the
# TaskCompleted hook and by the Chief on assignment changes. Dependency-free.
set -u
ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
cd "$ROOT" || exit 0
TS=$(date +%Y%m%d-%H%M%S)
DIR="decisions/checkpoints"
OUT="$DIR/checkpoint-$TS.md"
mkdir -p "$DIR"
{
  echo "# Checkpoint $TS"
  echo
  echo "## Task states (from tasks/*.md frontmatter)"
  for f in tasks/T-*.md; do
    [ -e "$f" ] || continue
    id=$(awk -F': *' '/^id:/{print $2; exit}' "$f")
    st=$(awk -F': *' '/^status:/{print $2; exit}' "$f")
    sg=$(awk -F': *' '/^stage:/{print $2; exit}' "$f")
    ow=$(awk -F': *' '/^owner_agent:/{print $2; exit}' "$f")
    echo "- $id [$st] stage=$sg owner=$ow ($f)"
  done
  echo
  echo "## Git branches"
  git branch -v --no-color 2>/dev/null || echo "(not a git repo)"
  echo
  echo "## Recent commits (all branches)"
  git log --oneline --all -15 2>/dev/null || true
} > "$OUT"
cp "$OUT" "$DIR/latest.md"
# keep the 20 most recent timestamped checkpoints
ls -1t "$DIR"/checkpoint-*.md 2>/dev/null | tail -n +21 | xargs -r rm -f
exit 0
