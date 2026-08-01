---
name: zed
description: Zed integration for viewing diffs and comparing files. Use when showing file differences to the user.
---

# Zed CLI Tools

Tools for integrating with Zed, primarily for viewing diffs.

## Requirements

Zed must be installed with the `zed` CLI available in PATH. If it is missing, the
user installs it from inside Zed: command palette (`cmd-shift-P`) → `cli: install`.

Verify with `zed --version`.

## Opening a Diff

Compare two files side by side:

```bash
zed --diff old.txt new.txt
```

### Several diffs at once

`--diff` is repeatable. Prefer one invocation over several — it opens a single
window instead of stealing focus repeatedly:

```bash
zed --diff old1.rs new1.rs --diff old2.rs new2.rs
```

### Whole directories

Given directories, Zed recurses and shows every changed file in one multi-diff
view. Identical files are omitted:

```bash
zed --diff ./before ./after
```

This is the main advantage over other editors' diff CLIs — use it whenever you are
showing more than two or three changed files.

## Git Diffs in Zed

### Uncommitted changes — use the built-in view

Do **not** build temp files for this. Zed ships a project diff for the working
tree; just open the project and use the Git panel:

```bash
zed .
```

### Against a specific revision

Extract the old version, then diff:

```bash
# Compare with previous commit
git show HEAD~1:path/to/file > /tmp/old && zed --diff /tmp/old path/to/file

# Compare with specific commit
git show abc123:path/to/file > /tmp/old && zed --diff /tmp/old path/to/file

# Compare staged version with working tree
git show :path/to/file > /tmp/staged && zed --diff /tmp/staged path/to/file
```

### A whole subtree against a revision

Materialize the old tree with `git archive`, then diff directories. This shows
every file changed between the revisions in one view:

```bash
tmp=$(mktemp -d)
git archive HEAD~1 -- src | tar -x -C "$tmp"
zed --diff "$tmp/src" src
```

Scope it with a pathspec (`-- src` above). Archiving the whole repo also pulls in
vendored directories and makes the diff unreadable.

### Viewing a raw patch

Zed reads stdin with `-`:

```bash
git diff HEAD~1 HEAD | zed -
```

Use this for review of a patch as text; use `--diff` when the user needs to compare
file contents side by side.

## Useful Flags

| Flag | Effect |
|---|---|
| `-n`, `--new` | Open in a new window instead of reusing one |
| `-a`, `--add` | Add the paths to the current workspace |
| `-e`, `--existing` | Force reuse of an existing window |
| `-w`, `--wait` | Block until the file/window is closed |
| `path:line:col` | Open at a position, e.g. `zed src/app.rs:42:10` |

`--wait` is what you need when a command must not continue until the user is done
looking (for example using Zed as a `$GIT_EDITOR`).

## Gotchas

- File must exist and actually differ; identical inputs open an empty diff.
- Use `git log --oneline -5 -- path/to/file` to confirm a file has history before
  diffing against a revision.
- `git show <rev>:<path>` needs a repo-root-relative path, not a path relative to
  your current directory. Use `git show <rev>:./file` for the relative form.
- Temp files are named after the temp path, so the diff header shows `/tmp/old`
  rather than the real filename. Name them meaningfully when it matters:
  `git show HEAD~1:src/app.js > /tmp/app.js.old`.
- `zed --diff` returns immediately (exit 0) once Zed is handed the paths; it does
  not indicate the user has looked at anything. Add `-w` to wait.

## When to Use

- Showing the user what changed in a file
- Comparing two versions of code
- Reviewing git changes visually
- Presenting the result of a large refactor across many files (directory diff)
