# agent-stuff

Personal [Pi Coding Agent](https://pi.dev) package containing extensions,
skills, and the Catppuccin Frappé theme.

## Install

```sh
pi install git:github.com/zekurio/agent-stuff
```

Pi installs the package dependencies with npm. My Nix configuration instead
pins this repository as a flake input and materializes the dependencies in the
Nix store, so Pi only loads a local package at runtime.

## Contents

- Extensions for async agents, Git workflows, model effort, priority routing,
  Firecrawl search, image anchors, Q&A, side questions, sleep prevention,
  Anthropic authentication, and direnv.
- `rift` and `zed` agent skills.
- Catppuccin Frappé theme.

`effort.json` and `priority-routing.json` are mutable, extension-owned state and
are intentionally not part of the package. `git-flow.ts` defaults to
`openai-codex/gpt-5.6-luna`; override it with `PI_GIT_MODEL`, project-local
`.pi/git-flow.json`, or global `~/.pi/agent/git-flow.json`.

Firecrawl search requires `FIRECRAWL_API_KEY`. The `rift` skill requires
[rift](https://github.com/anomalyco/rift), and the `zed` skill requires the Zed
CLI.

## License

Apache-2.0. Third-party notices and MIT licenses are in [NOTICE](NOTICE) and
[LICENSES](LICENSES/).
