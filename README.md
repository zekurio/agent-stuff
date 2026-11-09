# agent-stuff

My shared agent skills and [Pi](https://pi.dev) extensions.

## Skills


| Skill | What it does |
| --- | --- |
| [`babysit`](skills/babysit/SKILL.md) | Watches a PR through CI and review rounds, fixes findings, and merges it with `full-send`. |
| [`bro`](skills/bro/SKILL.md) | Restates the last response in plain language. |
| [`frontend-design`](skills/frontend-design/SKILL.md) | Guides distinctive visual design for frontend work. |
| [`git-forges`](skills/git-forges/SKILL.md) | Inspects Git forges with Git, raw file requests, and forge-native CLIs. |
| [`improve`](skills/improve/SKILL.md) | Audits a codebase read-only and writes self-contained implementation plans for other agents. |
| [`sol-loop`](skills/sol-loop/SKILL.md) | Works through a review or discussion in rounds with a GPT-6.1 Sol subagent. |
| [`unslop`](skills/unslop/SKILL.md) | Removes stock AI phrasing and rewrites prose in a human voice. |

### Updating vendored skills

`frontend-design`, `bro`, `improve`, and `unslop` are copied from upstream repositories.
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
vendored source silently. `improve` gets a patch too: under T3 Code it runs its
subagents and executors through T3's orchestrator tools instead of the
harness's own subagents.

## Pi extensions

| Extension | What it does |
| --- | --- |
| [`firecrawl`](extensions/firecrawl) | Adds `web_search` and `web_extract` tools backed by [Firecrawl](https://firecrawl.dev). |
| [`image-placeholders`](extensions/image-placeholders) | Shows pasted and dropped images as `[Image #N]` and attaches them to the prompt. |

`web_search` returns titles, URLs, and snippets. It can filter by domain
and by recency. `web_extract` reads one page as markdown, 12,000 characters
per call by default. The model pages on with `offset`, or passes `query` to get
only the passages around a literal match. Pi keeps scraped pages for 10
minutes, so paging does not spend more credits.

The tools call Firecrawl's REST API with `fetch` and have no runtime
dependencies. They stay off until `FIRECRAWL_API_KEY` is set, and Pi warns at
startup when it is missing. Set `FIRECRAWL_URL` to use a self-hosted instance,
where the key is optional.

Stock Pi saves a `Ctrl+V` image to a temp file and types that path into the
prompt. The model then has to call `read` on the path to see the image.
`image-placeholders` puts `[Image #1]` in the editor instead and attaches the
image to the prompt when you send it, so the model sees it right away.
Dropping an image file into the terminal works the same way, whether the
terminal sends a plain path, a quoted or escaped path, or a `file://` URI.
Numbers keep counting up for the whole Pi process, so a prompt recalled from
history still attaches its own image. Backspace, Delete, and the arrow keys
treat a placeholder as one character, like Pi's `[paste #N]` markers. This
wraps a private editor method, so a Pi update can quietly turn it back into
character-by-character deletion. In bash mode (`!`) the real path is
inserted. The extension replaces Pi's editor, so it conflicts with other
extensions that also replace it.

Without Nix, install the package with Pi:

```sh
pi install git:github.com/zekurio/agent-stuff
```

This also loads the skills from the package. If you already link them into
`~/.agents/skills`, filter them out with `"skills": []` in the package entry of
`~/.pi/agent/settings.json`.

To work on the extensions:

```sh
npm install
npm run check   # type-check against Pi's types and run the tests
```

## Windows

Run in PowerShell:

```powershell
irm https://raw.githubusercontent.com/zekurio/agent-stuff/main/scripts/install-windows.ps1 | iex
```

This downloads the repository ZIP into `%LOCALAPPDATA%\agent-stuff` and links
its skills into `%USERPROFILE%\.agents\skills` using directory junctions.
No Git installation or administrator rights are needed. Rerun to download
updates and link new skills; files removed upstream are not automatically pruned.
Conflicting entries in your skills directory are preserved and stop the script.
For a custom skills directory, save the script and run it with `-Destination <path>`.

To check the installer in a temporary directory:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-install-windows.ps1
```

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

The module links each skill at `~/.agents/skills`. It also links the package
at `~/.pi/agent/packages/agent-stuff` and registers it in Pi's `settings.json`
without touching other settings or packages. Pi loads the extensions from
there, and the skills only from `~/.agents/skills`. To skip the Pi part, set:

```nix
{
  programs.agent-stuff.pi.enable = false;
}
```

The next activation then removes the entry from `settings.json`.

The flake also exports `packages.<system>.default`,
`packages.<system>.agent-stuff`, and an overlay that adds `pkgs.agent-stuff`.

## License

[MIT](LICENSE)
