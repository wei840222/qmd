#!/usr/bin/env bash
set -euo pipefail

# Explicit hook installation for normal checkouts and linked worktrees.
# Resolve core.hooksPath through Git; preserve an existing hook before replacing it.

repo_root=$(git rev-parse --show-toplevel 2>/dev/null || true)
if [[ -z "$repo_root" ]]; then
  echo "Error: not in a git repository" >&2
  exit 1
fi
cd "$repo_root"

hooks_dir=$(git rev-parse --path-format=absolute --git-path hooks)
hook_source="$repo_root/scripts/pre-push"
hook_target="$hooks_dir/pre-push"

if [[ ! -f "$hook_source" ]]; then
  echo "Error: scripts/pre-push not found at $hook_source" >&2
  exit 1
fi

mkdir -p "$hooks_dir"
if [[ -f "$hook_target" && ! -L "$hook_target" && -x "$hook_target" ]] && cmp -s "$hook_source" "$hook_target"; then
  echo "pre-push hook: already installed"
  exit 0
fi

if [[ -e "$hook_target" || -L "$hook_target" ]]; then
  hook_backup="$hook_target.backup.$(date +%s).$$"
  mv "$hook_target" "$hook_backup"
  echo "pre-push hook: backed up existing hook to $hook_backup"
fi

# Copy rather than link: shared hooks must survive removal of this worktree.
cp "$hook_source" "$hook_target"
chmod 755 "$hook_target"
echo "pre-push hook: installed at $hook_target"
