{self}: {
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = config.programs.agent-stuff;
  packageSource = "./packages/agent-stuff";
  agentDirectory = "${config.home.homeDirectory}/.pi/agent";
in {
  options.programs.agent-stuff = {
    enable = lib.mkEnableOption "the agent-stuff Pi package";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "inputs.agent-stuff.packages.${pkgs.stdenv.hostPlatform.system}.default";
      description = "The agent-stuff package to install.";
    };
  };

  config = lib.mkIf cfg.enable {
    # Jiti otherwise caches transformed extensions in the shared /tmp/jiti.
    # Immutable store sources do not need that cache, and concurrent first
    # launches can observe a stale or partially written transform there.
    home.sessionVariables.JITI_FS_CACHE = "false";

    home.file.".pi/agent/packages/agent-stuff".source = cfg.package;

    # Pi mutates settings.json, so keep it writable and only reconcile this
    # package entry. Preserve model choices and any other installed packages.
    home.activation.agentStuff = lib.hm.dag.entryAfter ["linkGeneration"] ''
      settings=${lib.escapeShellArg "${agentDirectory}/settings.json"}
      if [[ -v DRY_RUN ]]; then
        verboseEcho "Would register ${packageSource} in $settings"
      else
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
          '.packages = (((if (.packages | type) == "array" then .packages else [] end) | map(select((if type == "object" then .source else . end) != $source))) + [$source])' \
          "$current" > "$temporary"
        mv "$temporary" "$settings"
      fi
    '';
  };
}
