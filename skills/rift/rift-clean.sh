#!/usr/bin/env bash
# Remove rift workspaces and reclaim their disk space.
# Refuses to discard uncommitted subagent work unless forced.
set -euo pipefail

usage() {
	cat >&2 <<'EOF'
Usage: rift-clean.sh [WORKSPACE...] [--all] [--from DIR] [--force]

  WORKSPACE...  Specific workspaces to remove.
  --all         Remove every workspace created from the root (keeps the root).
  --from DIR    Root to clean. Default: current directory.
  --force       Remove even if a workspace has uncommitted changes.

Removal moves workspaces to rift's trash, then 'rift gc' deletes them.
EOF
}

targets=()
root="$PWD"
all=0
force=0

while [ $# -gt 0 ]; do
	case "$1" in
		-h|--help) usage; exit 0 ;;
		--all) all=1; shift ;;
		--force|-f) force=1; shift ;;
		--from) root="${2:?--from needs a directory}"; shift 2 ;;
		-*) echo "rift-clean: unknown option $1" >&2; usage; exit 2 ;;
		*) targets+=("$1"); shift ;;
	esac
done

command -v rift >/dev/null 2>&1 || { echo "rift-clean: 'rift' not found in PATH" >&2; exit 127; }
[ -d "$root" ] || { echo "rift-clean: not a directory: $root" >&2; exit 2; }
root="$(cd "$root" && pwd -P)"

if [ "$all" -eq 0 ] && [ "${#targets[@]}" -eq 0 ]; then
	usage
	exit 2
fi

if [ "$all" -eq 1 ]; then
	targets=()
	while IFS= read -r line; do
		[ -n "$line" ] && targets+=("$line")
	done < <(cd "$root" && rift list 2>/dev/null || true)
	if [ "${#targets[@]}" -eq 0 ]; then
		echo "rift-clean: no workspaces created from $root"
		exit 0
	fi
fi

# Guard: uncommitted work in a workspace is unrecoverable once trashed.
blocked=0
for ws in "${targets[@]}"; do
	[ -n "$ws" ] && [ -d "$ws" ] || continue
	if git -C "$ws" rev-parse --git-dir >/dev/null 2>&1 && [ -n "$(git -C "$ws" status --porcelain)" ]; then
		echo "rift-clean: $ws has uncommitted changes:" >&2
		git -C "$ws" status --short >&2
		blocked=1
	fi
done
if [ "$blocked" -eq 1 ] && [ "$force" -eq 0 ]; then
	echo "rift-clean: refusing to discard uncommitted work. Collect it first, or pass --force." >&2
	exit 1
fi

removed=0
for ws in "${targets[@]}"; do
	[ -n "$ws" ] || continue
	if rift remove "$ws" >/dev/null 2>&1; then
		echo "rift-clean: removed $ws"
		removed=$((removed + 1))
	else
		echo "rift-clean: could not remove $ws (already gone?)" >&2
	fi
done

freed="$(rift gc 2>/dev/null | wc -l | tr -d ' ')"
echo "rift-clean: removed $removed workspace(s), gc reclaimed $freed path(s)"
