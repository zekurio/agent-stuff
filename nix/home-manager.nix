{self}: {
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = config.programs.agent-stuff;
  packageSource = "./packages/agent-stuff";
  agentDirectory = "${config.home.homeDirectory}/.pi/agent";
  globalSkills = lib.mapAttrs' (name: _:
    lib.nameValuePair ".agents/skills/${name}" {
      source = "${cfg.package}/skills/${name}";
    }) (lib.filterAttrs (_: type: type == "directory") (builtins.readDir ../skills));

  # Adds or removes this package's entry and leaves the rest of the settings
  # alone. Skills are filtered out because Pi already loads ~/.agents/skills.
  settingsFilter = ''
    def without($source):
      map(select((if type == "object" then .source else . end) != $source));
    if $register then
      .packages = (((.packages | arrays) // []) | without($source))
        + [{source: $source, skills: []}]
    elif (.packages | type) == "array" then
      .packages |= without($source)
    else
      .
    end
  '';
in {
  options.programs.agent-stuff = {
    enable = lib.mkEnableOption "the agent-stuff skills";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "inputs.agent-stuff.packages.${pkgs.stdenv.hostPlatform.system}.default";
      description = "The agent-stuff package to install.";
    };

    pi.enable = lib.mkOption {
      type = lib.types.bool;
      default = true;
      example = false;
      description = ''
        Whether to register the package with Pi so its extensions load.
        Skills load from ~/.agents/skills either way.
      '';
    };
  };

  config = lib.mkIf cfg.enable (lib.mkMerge [
    {
      home.file = globalSkills;

      # Pi mutates settings.json, so keep it writable and only reconcile this
      # package entry. Disabling pi.enable removes the entry again.
      home.activation.agentStuff = lib.hm.dag.entryAfter ["linkGeneration"] ''
        settings=${lib.escapeShellArg "${agentDirectory}/settings.json"}
        if [[ -v DRY_RUN ]]; then
          verboseEcho "Would reconcile ${packageSource} in $settings"
        elif [ -e "$settings" ] || ${lib.boolToString cfg.pi.enable}; then
          mkdir -p ${lib.escapeShellArg agentDirectory}

          if [ -e "$settings" ]; then
            if ! ${lib.getExe pkgs.jq} -e 'type == "object"' "$settings" >/dev/null 2>&1; then
              echo "agent-stuff: refusing to replace invalid Pi settings at $settings" >&2
              exit 1
            fi
            current="$settings"
          else
            current=${pkgs.writeText "empty-pi-settings.json" "{}"}
          fi

          umask 077
          temporary="$settings.tmp"
          ${lib.getExe pkgs.jq} \
            --arg source ${lib.escapeShellArg packageSource} \
            --argjson register ${lib.boolToString cfg.pi.enable} \
            ${lib.escapeShellArg settingsFilter} \
            "$current" > "$temporary"
          mv "$temporary" "$settings"
        fi
      '';
    }

    (lib.mkIf cfg.pi.enable {
      # Jiti otherwise caches transformed extensions in the shared /tmp/jiti.
      # Immutable store sources do not need that cache, and concurrent first
      # launches can observe a stale or partially written transform there.
      home.sessionVariables.JITI_FS_CACHE = "false";

      home.file.".pi/agent/packages/agent-stuff".source = cfg.package;
    })
  ]);
}
