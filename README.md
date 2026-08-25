# agent-stuff

My [Pi Coding Agent](https://pi.dev) setup, packaged so I can install it on any
machine. It includes my extensions, agent skills, and Catppuccin Frappé theme.

## Install

```sh
pi install git:github.com/zekurio/agent-stuff
```

Pi clones the repository and installs its npm dependencies.

## What's included

### Extensions

| Extension | What it does |
| --- | --- |
| [`answer`](extensions/answer.ts) | Pulls questions from the last assistant message into an interactive Q&A. Run it with `/answer` or `ctrl+.`. |
| [`async-agents`](extensions/async-agents.ts) | Adds the `agent` tool for background subagents and `/agents` for checking or cancelling jobs. |
| [`btw`](extensions/btw.ts) | Opens a side conversation without adding it to the main thread. |
| [`effort`](extensions/effort.ts) | Changes the current model's reasoning effort with `/effort`. |
| [`firecrawl-search`](extensions/firecrawl-search) | Adds `search`, `scrape`, and `crawl` tools backed by Firecrawl. |
| [`git-flow`](extensions/git-flow.ts) | Adds `/commit`, `/push`, and `/pr`. It reads the repository's conventions and pull request template. |
| [`image-anchors`](extensions/image-anchors.ts) | Replaces pasted image paths with short labels in the editor, then restores them on submit. |
| [`no-sleep`](extensions/no-sleep.ts) | Keeps macOS awake while Pi's agent is running. |
| [`priority-routing`](extensions/priority-routing.ts) | Toggles provider priority routing with `/priority` or `/fast`. |
| [`pi-direnv`](extensions/pi-direnv) | Loads the nearest `.envrc` into Pi when a session starts. |

### Skills

| Skill | What it does |
| --- | --- |
| [`bro`](skills/bro/SKILL.md) | Restates the last response in plain language. |
| [`rift`](skills/rift/SKILL.md) | Splits large jobs across isolated [rift](https://github.com/anomalyco/rift) workspaces and collects the resulting commits. |
| [`teach`](skills/teach/SKILL.md) | Explains code and changes in small, plain steps. |
| [`unslop`](skills/unslop/SKILL.md) | Removes stock AI phrasing and rewrites prose in a human voice. |
| [`zed`](skills/zed/SKILL.md) | Opens file and Git comparisons in Zed. |

The [Catppuccin Frappé](themes/catppuccin-frappe.json) theme is included too.

## Configuration

Firecrawl needs `FIRECRAWL_API_KEY`. The `rift` skill needs the `rift` command,
and the `zed` skill needs the Zed CLI.

`git-flow.ts` uses `openai-codex/gpt-5.6-luna` by default. Set `PI_GIT_MODEL`,
add `.pi/git-flow.json` to a project, or add `~/.pi/agent/git-flow.json` to
change it.

The effort and priority-routing extensions write their state to `effort.json`
and `priority-routing.json`. Git ignores both files.

## Nix and Home Manager

The flake builds the package with its npm dependencies already in the Nix store.
It also provides a Home Manager module.

Add the flake to your inputs and import the module:

```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    agent-stuff = {
      url = "github:zekurio/agent-stuff";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = inputs: {
    homeConfigurations.alice =
      inputs.home-manager.lib.homeManagerConfiguration {
        pkgs = inputs.nixpkgs.legacyPackages.x86_64-linux;
        modules = [
          inputs.agent-stuff.homeManagerModules.default
          ./home.nix
        ];
      };
  };
}
```

Enable it in your Home Manager configuration:

```nix
{
  programs.agent-stuff.enable = true;
}
```

The module links the package at `~/.pi/agent/packages/agent-stuff` and its skills
at `~/.agents/skills`. It adds the package path to Pi's `settings.json` without
changing model settings or other packages.

The flake also exports `packages.<system>.default`,
`packages.<system>.agent-stuff`, and an overlay that adds `pkgs.agent-stuff`.

## License

[MIT](LICENSE)
