---
name: rift
description: Split a large task across parallel subagents, each in an isolated copy-on-write workspace, then merge their work back via git. Use when a task is big enough to fan out (3+ independent chunks), when parallel agents would otherwise collide on the same files, or when you want to try several approaches to the same problem and keep the best one.
---

# Rift: parallel delegation in isolated workspaces

`rift` makes near-instant copy-on-write clones of a repository. Each subagent gets
its own real working directory, so several agents can edit, build, and run tests at
the same time without stepping on each other. Work comes back through git.

> **Helper scripts** live in the same directory as this `SKILL.md`. Below, `{baseDir}`
> means that directory — substitute its absolute path when running commands.
> Check with `ls {baseDir}` if unsure; all four scripts accept `--help`.

## When to use this

Use it when:
- The task splits into **3+ chunks that touch different files** (migrate 12 modules, add tests to 8 packages, fix 20 lint categories).
- Parallel agents would otherwise conflict — two agents editing the same checkout will corrupt each other's work.
- You want **N attempts at one problem** (different approaches to a refactor) and will keep the best.
- A chunk needs to run builds/tests that mutate the tree (codegen, migrations, `node_modules` changes).

Do **not** use it when:
- The work is sequential — chunk B needs to see chunk A's result. Just do it in order.
- It is small enough for one agent. Fan-out costs a clone plus a merge per chunk.
- Chunks all edit the same file. You will only create merge conflicts. Split by file ownership or do it serially.

For read-only work (recon, search, doc-reading) skip rift entirely and use plain
`agent` calls in the current directory. Isolation only matters when agents **write**.

## One-time setup

The repository must be registered once. This is a deliberate step because on
Linux/btrfs it converts the directory into a subvolume in place.

```bash
cd <repo root> && rift init
```

Verify with `ls .rift` (a marker file containing a ULID).

## The loop

### 1. Plan the split

Write down the chunks and, for each, **which files it owns**. Non-overlapping
ownership is what makes the merges clean. If two chunks want the same file, merge
them into one chunk.

Keep it to 3–5 parallel agents. The `agent` tool refuses more than 6 concurrent jobs,
and merge review cost grows faster than the parallelism saves.

### 2. Create one workspace per chunk

```bash
{baseDir}/rift-new.sh parser-fix
```

Prints **only** the absolute workspace path on stdout, so capture it directly:

```bash
WS=$({baseDir}/rift-new.sh parser-fix)
```

Commit or stash first if you can: rift copies your uncommitted changes into every
workspace, and the script warns when it finds them.

### 3. Launch one subagent per workspace, with `cwd`

Start them all in a single message so they run concurrently, then `wait` once:

```
agent{action:"start", label:"parser-fix", cwd:"<WS>", model:"...", task:"<brief>"}
agent{action:"start", label:"lexer-fix",  cwd:"<WS2>", model:"...", task:"<brief>"}
...
agent{action:"wait"}
```

`cwd` is what pins the subagent to its workspace — without it every agent runs in
your directory and the isolation is gone.

Subagents cannot delegate further (the `agent` tool is withheld from them by
default), so plan a flat fan-out, not a tree.

### 4. Collect each workspace

```bash
{baseDir}/rift-collect.sh <WS> <branch-name>
```

Fetches the workspace's commits into a local branch in your repo and prints the
commits and diffstat. It does **not** merge — you review first. If the subagent
forgot to commit, this fails loudly; re-run with `--auto-commit` to salvage the work.

Check everything at a glance before collecting:

```bash
{baseDir}/rift-status.sh
```

Then merge the branches you want:

```bash
git diff <base>...<branch>        # review
git merge --no-ff <branch>        # accept
```

Merge one branch at a time and resolve conflicts as they appear. If two branches
conflict badly, that means step 1's split was wrong — prefer one branch and re-run
the other chunk on top of the merged result.

### 5. Clean up

Workspaces are full repo copies. They cost little disk (copy-on-write) but they are
not free, and they linger after the session ends.

```bash
{baseDir}/rift-clean.sh --all
```

Refuses to delete a workspace with uncommitted changes unless you pass `--force`.

## The subagent brief

This is the highest-leverage part. A subagent that does not commit produces nothing
collectable. Always include the commit instruction. Template:

```
You are working in an isolated workspace at <WS>, a full copy of the repo on a
detached HEAD. Nothing you do here affects other agents.

Goal: <one specific, verifiable outcome>

Files you own: <explicit paths>
Do not modify files outside that set — another agent owns them and your edits
would be thrown away in the merge.

Verify with: <exact build/test command>

When finished you MUST commit, or your work is lost:
    git add -A && git commit -m "<conventional commit message>"

Then report:
  - the commit sha and the message
  - files changed and why
  - anything the integrator must know: API/signature changes, new deps,
    assumptions you made, follow-up work you did not do

If you cannot finish, commit the partial work anyway and say exactly what is
missing. Never report success without a commit.
```

## Gotchas

- **Detached HEAD.** Workspaces are not on a branch. That is fine — `rift-collect.sh`
  fetches `HEAD` directly. Subagents should not need to create branches.
- **Uncommitted work is invisible.** Nothing reaches you until the subagent commits.
  This is the single most common failure; the brief must demand a commit.
- **`--copy-all` is the default here, on purpose.** rift's filtered mode fails with
  `Permission denied (os error 13)` on macOS whenever the tree contains a read-only
  (0444) file — and every git loose object is 0444, so it never works on a repo.
  Copy-on-write means copying `node_modules` costs almost nothing, and it also means
  dependencies are already installed in the workspace. Verified against rift 0.0.10.
- **`rift create` needs an initialized root.** Run `rift init` once, or pass `--init`
  to `rift-new.sh`.
- **Storage lives beside the repo**, at `../.rifts/<repo>/<name>/`, never inside it.
  Add nothing to `.gitignore`; rift writes `/.rift` into `.git/info/exclude` itself.
- **Removal is two-phase.** `rift remove` trashes, `rift gc` reclaims. `rift-clean.sh`
  does both.
- **rift is experimental** (0.0.x, "interfaces may change without notice"). If a
  helper script breaks, check `rift --help` and the marker/registry state before
  assuming the skill is wrong.

## Full example

Adding tests to three independent packages:

```bash
# setup, once
cd ~/code/app && rift init

# one workspace per chunk
A=$({baseDir}/rift-new.sh tests-auth)
B=$({baseDir}/rift-new.sh tests-api)
C=$({baseDir}/rift-new.sh tests-db)
```

Then, in one message: three `agent{action:"start", cwd:...}` calls with briefs
scoped to `src/auth/**`, `src/api/**`, `src/db/**` respectively, followed by a
single `agent{action:"wait"}`.

```bash
# see who actually committed
{baseDir}/rift-status.sh

# pull each into a branch
{baseDir}/rift-collect.sh "$A" tests-auth
{baseDir}/rift-collect.sh "$B" tests-api
{baseDir}/rift-collect.sh "$C" tests-db

# review, merge, tidy
git merge --no-ff tests-auth && git merge --no-ff tests-api && git merge --no-ff tests-db
{baseDir}/rift-clean.sh --all
```

## Helper reference

| Script | Purpose |
|---|---|
| `{baseDir}/rift-new.sh [NAME] [--init] [--from DIR]` | Create a workspace; prints its path on stdout |
| `{baseDir}/rift-status.sh [ROOT]` | List workspaces with commit/dirty state |
| `{baseDir}/rift-collect.sh WS [BRANCH] [--auto-commit]` | Fetch a workspace's commits into a local branch |
| `{baseDir}/rift-clean.sh [--all] [--force]` | Remove workspaces and reclaim space |

All scripts accept `--help`.
