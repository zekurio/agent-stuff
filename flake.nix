{
  description = "Personal agent skills and Pi extensions";

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

    checks = forAllSystems (system: let
      pkgs = nixpkgs.legacyPackages.${system};
      # The tests import only the Firecrawl client, so they need no npm deps.
      extensions = nixpkgs.lib.fileset.toSource {
        root = ./.;
        fileset = ./extensions;
      };
    in {
      package = self.packages.${system}.agent-stuff;
      extension-tests =
        pkgs.runCommand "agent-stuff-extension-tests" {
          nativeBuildInputs = [pkgs.nodejs_26];
        } ''
          cd ${extensions}
          node --test "extensions/**/*.test.ts"
          touch "$out"
        '';
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
        packages = [pkgs.nodejs_26];
      };
    });
  };
}
