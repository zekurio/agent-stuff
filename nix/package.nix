{
  stdenvNoCC,
  lib,
}: let
  tests = lib.fileset.fileFilter (file: lib.hasSuffix ".test.ts" file.name) ../extensions;
in
  stdenvNoCC.mkDerivation {
    pname = "agent-stuff";
    version = (lib.importJSON ../package.json).version;

    # A Pi package root. The extensions import only modules that Pi provides,
    # so the package needs no node_modules.
    src = lib.fileset.toSource {
      root = ../.;
      fileset = lib.fileset.unions [
        ../package.json
        ../LICENSE
        ../skills
        (lib.fileset.difference ../extensions tests)
      ];
    };
    dontBuild = true;

    installPhase = ''
      runHook preInstall

      mkdir -p "$out"
      cp -r . "$out"

      runHook postInstall
    '';

    meta = {
      description = "Personal agent skills and Pi extensions";
      homepage = "https://github.com/zekurio/agent-stuff";
      license = lib.licenses.mit;
      platforms = lib.platforms.unix;
    };
  }
