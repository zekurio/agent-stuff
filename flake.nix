{
  description = "Pi Coding Agent extensions, skills, and themes";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = {
    self,
    nixpkgs,
  }: let
    supportedSystems = [
      "aarch64-darwin"
      "aarch64-linux"
      "x86_64-linux"
    ];
    forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
  in {
    packages = forAllSystems (system: let
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      agent-stuff = pkgs.callPackage ./nix/package.nix {};
      default = self.packages.${system}.agent-stuff;
    });

    checks = forAllSystems (system: {
      package = self.packages.${system}.agent-stuff;
    });

    homeManagerModules = {
      agent-stuff = import ./nix/home-manager.nix {inherit self;};
      default = self.homeManagerModules.agent-stuff;
    };

    overlays.default = final: _prev: {
      agent-stuff = final.callPackage ./nix/package.nix {};
    };

    formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.alejandra);

    devShells = forAllSystems (system: let
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      default = pkgs.mkShell {
        packages = [pkgs.nodejs_22];
      };
    });
  };
}
