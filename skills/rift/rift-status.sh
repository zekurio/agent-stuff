#!/usr/bin/env bash
# Show every rift workspace created from this root and whether its work is
# committed (collectable) or still dirty (would be lost on cleanup).
set -euo pipefail

case "${1:-}" in
	-h|--help)
		cat >&2 <<'EOF'
Usage: rift-status.sh [ROOT]

Lists every rift workspace created from ROOT (default: current directory) and
whether its work is committed (collectable) or still dirty (lost on cleanup).
EOF
		exit 0 ;;
esac

parent="${1:-$PWD}"
[ -d "$parent" ] || { echo "rift-status: not a directory: $parent" >&2; exit 2; }
parent="$(cd "$parent" && pwd -P)"

command -v rift >/dev/null 2>&1 || { echo "rift-status: 'rift' not found in PATH" >&2; exit 127; }

workspaces=()
while IFS= read -r line; do
	[ -n "$line" ] && workspaces+=("$line")
done < <(cd "$parent" && rift list 2>/dev/null || true)

if [ "${#workspaces[@]}" -eq 0 ]; then
	echo "No rift workspaces created from $parent"
	exit 0
fi

is_git=0
git -C "$parent" rev-parse --git-dir >/dev/null 2>&1 && is_git=1
head_short=""
[ "$is_git" -eq 1 ] && head_short="$(git -C "$parent" rev-parse --short HEAD 2>/dev/null || echo '?')"

echo "Workspaces from $parent${head_short:+ (HEAD $head_short)}:"
echo

for ws in "${workspaces[@]}"; do
	[ -n "$ws" ] || continue
	name="$(basename "$ws")"
	if [ ! -d "$ws" ]; then
		printf '  %-24s MISSING on disk (run: rift gc)\n' "$name"
		continue
	fi
	if [ "$is_git" -eq 0 ] || ! git -C "$ws" rev-parse --git-dir >/dev/null 2>&1; then
		printf '  %-24s %s\n' "$name" "$ws"
		continue
	fi

	dirty="$(git -C "$ws" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
	# Compute inside the workspace: it holds both its own new commits and the
	# parent's history, whereas the parent has not seen the workspace's objects.
	parent_head="$(git -C "$parent" rev-parse HEAD 2>/dev/null || true)"
	base=""
	[ -n "$parent_head" ] && base="$(git -C "$ws" merge-base HEAD "$parent_head" 2>/dev/null || true)"
	ahead="?"
	[ -n "$base" ] && ahead="$(git -C "$ws" rev-list --count "$base..HEAD" 2>/dev/null || echo '?')"

	if [ "$ahead" = "0" ] && [ "$dirty" = "0" ]; then
		state="idle - no work yet"
	elif [ "$dirty" != "0" ] && [ "$ahead" = "0" ]; then
		state="UNCOMMITTED ($dirty files) - not collectable yet"
	elif [ "$dirty" != "0" ]; then
		state="$ahead commit(s) + UNCOMMITTED ($dirty files) - commit before collecting"
	else
		state="ready - $ahead commit(s) to collect"
	fi
	printf '  %-24s %s\n' "$name" "$state"
	printf '  %-24s %s\n' "" "$ws"
	[ "$ahead" != "0" ] && [ "$ahead" != "?" ] && \
		git -C "$ws" log --oneline --no-decorate "$base..HEAD" 2>/dev/null | sed 's/^/                           /'
	echo
done

here="$(cd "$(dirname "$0")" && pwd -P)"
echo "Collect: $here/rift-collect.sh <workspace> <branch>"
echo "Clean:   $here/rift-clean.sh --all"
