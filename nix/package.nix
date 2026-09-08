{
  stdenvNoCC,
  lib,
}:
stdenvNoCC.mkDerivation {
  pname = "agent-stuff";
  version = (lib.importJSON ../package.json).version;

  src = ../skills;
  dontBuild = true;

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/skills"
    cp -r . "$out/skills"

    runHook postInstall
  '';

  meta = {
    description = "Personal agent skills";
    homepage = "https://github.com/zekurio/agent-stuff";
    license = lib.licenses.mit;
    platforms = lib.platforms.unix;
  };
}
