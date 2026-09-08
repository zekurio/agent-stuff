{self}: {
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = config.programs.agent-stuff;
  globalSkills = lib.mapAttrs' (name: _:
    lib.nameValuePair ".agents/skills/${name}" {
      source = "${cfg.package}/skills/${name}";
    }) (lib.filterAttrs (_: type: type == "directory") (builtins.readDir ../skills));
in {
  options.programs.agent-stuff = {
    enable = lib.mkEnableOption "the agent-stuff skills";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "inputs.agent-stuff.packages.${pkgs.stdenv.hostPlatform.system}.default";
      description = "The agent-stuff package to install.";
    };
  };

  config = lib.mkIf cfg.enable {
    home.file = globalSkills;
  };
}
