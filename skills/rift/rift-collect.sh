#!/usr/bin/env bash
# Pull a subagent's committed work out of its rift workspace into a local branch
# in the parent repository, then report what landed.
set -euo pipefail

usage() {
	cat >&2 <<'EOF'
Usage: rift-collect.sh WORKSPACE [BRANCH] [--into DIR] [--auto-commit]

  WORKSPACE      Path to the rift workspace the subagent worked in.
  BRANCH         Local branch to create in the parent. Default: rift/<workspace-name>
  --into DIR     Parent repository. Default: current directory.
  --auto-commit  Commit the workspace's uncommitted changes before fetching,
                 instead of failing. Use when the subagent forgot to commit.

Fetches WORKSPACE's HEAD into BRANCH and prints the commits and diffstat
relative to the parent's current HEAD. Does not merge; you review, then merge.
EOF
}

ws=""
branch=""
parent="$PWD"
auto_commit=0

while [ $# -gt 0 ]; do
	case "$1" in
		-h|--help) usage; exit 0 ;;
		--into) parent="${2:?--into needs a directory}"; shift 2 ;;
		--auto-commit) auto_commit=1; shift ;;
		-*) echo "rift-collect: unknown option $1" >&2; usage; exit 2 ;;
		*) if [ -z "$ws" ]; then ws="$1"; else branch="$1"; fi; shift ;;
	esac
done

[ -n "$ws" ] || { usage; exit 2; }
[ -d "$ws" ] || { echo "rift-collect: workspace does not exist: $ws" >&2; exit 2; }
ws="$(cd "$ws" && pwd -P)"
[ -f "$ws/.rift" ] || echo "rift-collect: warning: $ws has no .rift marker; not a rift workspace?" >&2

git -C "$ws" rev-parse --git-dir >/dev/null 2>&1 || { echo "rift-collect: $ws is not a git repository" >&2; exit 2; }
git -C "$parent" rev-parse --git-dir >/dev/null 2>&1 || { echo "rift-collect: $parent is not a git repository" >&2; exit 2; }

[ -n "$branch" ] || branch="rift/$(basename "$ws")"

# A subagent that never committed leaves nothing to fetch. Catch it loudly.
if [ -n "$(git -C "$ws" status --porcelain)" ]; then
	if [ "$auto_commit" -eq 1 ]; then
		echo "rift-collect: committing uncommitted work in $ws" >&2
		git -C "$ws" add -A
		git -C "$ws" -c user.email=rift@local -c user.name=rift commit -q -m "wip: uncommitted subagent work from $(basename "$ws")"
	else
		echo "rift-collect: ERROR: $ws has uncommitted changes:" >&2
		git -C "$ws" status --short >&2
		echo "rift-collect: the subagent did not commit. Re-run with --auto-commit, or commit in the workspace first." >&2
		exit 1
	fi
fi

before="$(git -C "$parent" rev-parse --verify -q "refs/heads/$branch" || true)"
git -C "$parent" fetch --no-tags --force "$ws" "HEAD:refs/heads/$branch" >/dev/null 2>&1 || {
	echo "rift-collect: git fetch from $ws failed" >&2
	exit 1
}
after="$(git -C "$parent" rev-parse "refs/heads/$branch")"

base="$(git -C "$parent" merge-base HEAD "$branch" 2>/dev/null || true)"
echo "rift-collect: $ws -> branch '$branch' ($after)"
if [ "$before" = "$after" ]; then
	echo "rift-collect: note: branch unchanged since last collect" >&2
fi

if [ -z "$base" ]; then
	echo "rift-collect: warning: no common ancestor with parent HEAD; unrelated history" >&2
	exit 0
fi

count="$(git -C "$parent" rev-list --count "$base..$branch")"
if [ "$count" = "0" ]; then
	echo "rift-collect: NO NEW COMMITS - the subagent produced nothing on top of $(git -C "$parent" rev-parse --short "$base")"
	exit 0
fi

echo
echo "Commits ($count):"
git -C "$parent" log --oneline --no-decorate "$base..$branch"
echo
echo "Files changed:"
git -C "$parent" diff --stat "$base...$branch"
echo
echo "Review:  git -C $parent diff $base...$branch"
echo "Merge:   git -C $parent merge --no-ff $branch"
