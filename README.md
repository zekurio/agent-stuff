# agent-stuff

Personal [Pi Coding Agent](https://pi.dev) package containing extensions,
skills, and the Catppuccin Frappé theme.

## Install

```sh
pi install git:github.com/zekurio/agent-stuff
```

Pi installs the package dependencies with npm. My Nix configuration instead
uses this repository's flake to materialize the dependencies in the Nix store,
so Pi only loads a local package at runtime.

### Nix / Home Manager

Add the flake as an input and import its Home Manager module:

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

Then enable it in your Home Manager configuration:

```nix
{
  programs.agent-stuff.enable = true;
}
```

The module links the complete package at
`~/.pi/agent/packages/agent-stuff` and registers it with Pi as
`./packages/agent-stuff`. It updates only that entry in Pi's mutable
`settings.json`; model choices and other installed packages are preserved.

The built package is also exposed as `packages.<system>.default` (and
`packages.<system>.agent-stuff`), and `overlays.default` adds it to nixpkgs as
`pkgs.agent-stuff`.

## Contents

- Extensions for async agents, Git workflows, model effort, priority routing,
  Firecrawl search, image anchors, Q&A, side questions, sleep prevention, and
  direnv.
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
