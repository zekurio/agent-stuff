# agent-stuff

My shared agent skills.

## Skills


| Skill | What it does |
| --- | --- |
| [`bro`](skills/bro/SKILL.md) | Restates the last response in plain language. |
| [`frontend-design`](skills/frontend-design/SKILL.md) | Guides distinctive visual design for frontend work. |
| [`git-forges`](skills/git-forges/SKILL.md) | Inspects Git forges with Git, raw file requests, and forge-native CLIs. |
| [`unslop`](skills/unslop/SKILL.md) | Removes stock AI phrasing and rewrites prose in a human voice. |

### Updating vendored skills

`frontend-design`, `bro`, and `unslop` are copied from upstream repositories.
Their source paths and imported commits live in
[`upstreams/skills.json`](upstreams/skills.json).

```sh
npm run skills:check   # report available upstream changes
npm run skills:update  # import the latest versions
```

The updater copies each skill and its license from a shallow clone. It then
applies any local patch under [`upstreams/patches`](upstreams/patches).
This repository enables `unslop` by default and adds a guard for factual
writing, so those changes are kept as a small patch instead of editing the
vendored source silently.

## Nix and Home Manager

The flake packages the skills and provides a Home Manager module.

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

The module links each skill at `~/.agents/skills`.

The flake also exports `packages.<system>.default`,
`packages.<system>.agent-stuff`, and an overlay that adds `pkgs.agent-stuff`.

## License

[MIT](LICENSE)
