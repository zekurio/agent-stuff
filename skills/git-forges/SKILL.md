---
name: git-forges
description: Inspect repositories and links from GitHub, GitLab, Codeberg, Forgejo, Gitea, SourceHut, and other Git forges with git, curl, or forge-native CLIs. Use whenever the user gives a forge URL, asks about a remote repository, or needs a README, source file, commit, diff, issue, pull request, release, or repository metadata. Do not scrape forge repository pages with Firecrawl.
---

# Git forges

Treat a forge as a Git remote and an API, not as a website to scrape.

## Rules

- Do not use Firecrawl `scrape` or `crawl` on repository, tree, blob, commit, issue, pull request, merge request, release, or raw-file URLs.
- Do not use Firecrawl `search` to inspect a known repository. Search is acceptable only to discover a repository when no URL or remote is known.
- Use `git` for repository contents and history.
- Use `curl` for one raw file or a forge API endpoint.
- Use a forge-native CLI when available, such as `gh` or `glab`, for issues, reviews, pull requests, and releases.
- Clone into a directory made with `mktemp -d`. Never clone into the user's project or modify the user's current worktree.
- Delete temporary clones when finished. Keep one only when follow-up work is likely, and tell the user its path.
- Never run code, hooks, installers, or build scripts from an untrusted repository just to inspect it. Read it as data.
- Prefer public, unauthenticated access. Do not print tokens or credentials. Existing CLI authentication may be used when the user asks about content it can access.

## Pick the cheapest method

### One README or source file

Fetch the raw file directly. Use `curl --fail --location --silent --show-error`, save it under a temporary directory, then inspect it with `read`. Do not curl the forge's rendered HTML page.

Common raw forms:

```text
GitHub: https://raw.githubusercontent.com/OWNER/REPO/REF/PATH
GitLab: https://HOST/NAMESPACE/REPO/-/raw/REF/PATH
Forgejo/Gitea: https://HOST/OWNER/REPO/raw/branch/REF/PATH
```

For a root README on GitHub or GitLab, `HEAD` often works as `REF`. Try likely names such as `README.md`, `README`, `README.rst`, and `README.adoc` only when needed. If the host's raw route, default branch, ref, or path is uncertain, use a sparse shallow clone instead of guessing repeatedly.

### Repository contents

Use a shallow, partial clone unless the question needs history:

```bash
repo_dir="$(mktemp -d -t forge-repo.XXXXXX)"
git clone --depth=1 --filter=blob:none --single-branch URL "$repo_dir"
printf '%s\n' "$repo_dir"
```

Inspect with `read`, `rg`, `find`, and `git -C "$repo_dir" ...`. Avoid dumping the whole repository into context. Start with the README, manifest, directory listing, and files relevant to the question.

For only top-level docs or a small path, prefer a sparse clone:

```bash
repo_dir="$(mktemp -d -t forge-repo.XXXXXX)"
git clone --depth=1 --filter=blob:none --sparse URL "$repo_dir"
git -C "$repo_dir" sparse-checkout set --no-cone '/README*' '/docs/*'
```

If partial clone is unsupported, retry without `--filter=blob:none`. If shallow clone is unsupported, retry without `--depth=1` only when necessary.

### A branch, tag, commit, tree, or blob URL

Preserve the ref from the URL. Clone the repository, then fetch and inspect that ref rather than silently reading the default branch:

```bash
git -C "$repo_dir" fetch --depth=1 origin REF
git -C "$repo_dir" checkout --detach FETCH_HEAD
```

A branch name may contain `/`, so do not split a `/tree/...` or `/blob/...` path by position and assume the first segment is the full ref. Resolve it with forge metadata, remote refs, or a clone. Commit hashes and tags are unambiguous.

### History or comparison

Fetch only what the task needs. Examples include a named branch, tag, commit, or enough depth for the requested comparison. Use `git show`, `git log`, `git diff`, `git blame`, and `git tag` locally. Do not scrape commit or comparison pages.

### Issues, pull requests, merge requests, releases, and CI

These objects are not always present in Git. Prefer the authenticated forge CLI, then the forge's JSON API via `curl` if no CLI is available.

Examples:

```bash
gh repo view OWNER/REPO
gh issue view NUMBER --repo OWNER/REPO
gh pr view NUMBER --repo OWNER/REPO
gh pr diff NUMBER --repo OWNER/REPO
glab issue view NUMBER --repo NAMESPACE/REPO
glab mr view NUMBER --repo NAMESPACE/REPO
```

Use Git refs for diffs when practical. For example, GitHub exposes pull request heads as `refs/pull/NUMBER/head`. API responses should be narrowed with `jq` so only relevant fields enter context.

## URL handling

- Strip UI suffixes such as `/tree/...`, `/blob/...`, `/-/issues/...`, or `/pull/...` when deriving the clone URL.
- Keep nested GitLab namespaces intact.
- Follow redirects when a repository moved.
- Prefer HTTPS clone URLs unless the environment already has working SSH access and private access is required.
- Treat unknown self-hosted forges as generic Git remotes first. Use `git ls-remote URL HEAD` to test access without cloning.

## Cleanup

Remove temporary data after answering:

```bash
rm -rf -- "$repo_dir"
```

Before removal, make sure the path came from `mktemp` and is not empty. Never use a broad glob for cleanup.
