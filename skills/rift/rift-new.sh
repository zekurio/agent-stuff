#!/usr/bin/env bash
# Create an isolated copy-on-write workspace for a delegated task.
# Prints ONLY the absolute workspace path on stdout, so it can be captured:
#     WS=$(rift-new.sh parser-fix)
set -euo pipefail

usage() {
	cat >&2 <<'EOF'
Usage: rift-new.sh [NAME] [--from DIR] [--into DIR] [--filtered] [--init]

  NAME        Workspace name. Default: rift picks a random adjective-noun.
  --from DIR  Source directory. Default: current directory.
  --into DIR  Destination parent directory. Default: <root>/../.rifts/<root>/
  --filtered  Exclude node_modules/target/dist/... Broken on macOS; see SKILL.md.
  --init      Run 'rift init' first when the source is not registered yet.
EOF
}

name=""
from="$PWD"
into=""
copy_all=1
do_init=0

while [ $# -gt 0 ]; do
	case "$1" in
		-h|--help) usage; exit 0 ;;
		--from) from="${2:?--from needs a directory}"; shift 2 ;;
		--into) into="${2:?--into needs a directory}"; shift 2 ;;
		--filtered) copy_all=0; shift ;;
		--init) do_init=1; shift ;;
		-*) echo "rift-new: unknown option $1" >&2; usage; exit 2 ;;
		*) name="$1"; shift ;;
	esac
done

command -v rift >/dev/null 2>&1 || {
	echo "rift-new: 'rift' not found in PATH. Install with: npm install -g rift-snapshot" >&2
	exit 127
}

[ -d "$from" ] || { echo "rift-new: --from directory does not exist: $from" >&2; exit 2; }
from="$(cd "$from" && pwd -P)"

# Walk up looking for the .rift marker that identifies a registered workspace.
find_root() {
	local d="$1"
	while :; do
		[ -f "$d/.rift" ] && { printf '%s\n' "$d"; return 0; }
		[ "$d" = "/" ] && return 1
		d="$(dirname "$d")"
	done
}

if ! root="$(find_root "$from")"; then
	if [ "$do_init" -eq 1 ]; then
		echo "rift-new: no .rift marker found, running 'rift init' in $from" >&2
		rift init >&2
		root="$(find_root "$from")" || { echo "rift-new: init did not register $from" >&2; exit 1; }
	else
		cat >&2 <<EOF
rift-new: $from is not a rift workspace (no .rift marker found in it or any parent).

Initialize it once, then retry:
    cd <repo root> && rift init

On Linux/btrfs 'rift init' converts the directory into a subvolume in place, so
run it deliberately rather than automatically. Pass --init to do it here.
EOF
		exit 1
	fi
fi

# Warn (do not block): rift copies dirty state, so subagents inherit your WIP.
if git -C "$from" rev-parse --git-dir >/dev/null 2>&1; then
	dirty="$(git -C "$from" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
	[ "$dirty" != "0" ] && echo "rift-new: note: $dirty uncommitted change(s) in $root will be copied into the workspace" >&2
fi

args=(create)
[ -n "$name" ] && args+=(--name "$name")
[ -n "$into" ] && args+=(--into "$into")
[ "$copy_all" -eq 1 ] && args+=(--copy-all)

if ! ws="$(cd "$from" && rift "${args[@]}" 2>&1)"; then
	echo "rift-new: rift ${args[*]} failed:" >&2
	printf '%s\n' "$ws" >&2
	case "$ws" in
		*"Permission denied"*)
			[ "$copy_all" -eq 0 ] && echo "rift-new: filtered create fails on read-only files (all git objects are 0444). Drop --filtered." >&2 ;;
	esac
	exit 1
fi

ws="$(printf '%s\n' "$ws" | tail -n1)"
[ -d "$ws" ] || { echo "rift-new: rift reported a path that does not exist: $ws" >&2; exit 1; }

echo "rift-new: created $ws (parent: $root)" >&2
printf '%s\n' "$ws"
