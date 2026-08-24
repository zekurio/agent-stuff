{
  buildNpmPackage,
  lib,
}:
buildNpmPackage {
  pname = "agent-stuff";
  version = (lib.importJSON ../package.json).version;

  src = lib.cleanSource ../.;

  npmDepsHash = "sha256-V46FzcTugJ3i0OH91dwWBUheIL6xi/+z0GIttec7Xtw=";
  npmInstallFlags = ["--ignore-scripts"];
  dontNpmBuild = true;
  doCheck = false;

  installPhase = ''
    runHook preInstall

    npm prune --omit=dev --ignore-scripts

    # Pi's bundled Bun runtime rejects follow-redirects' Error subclass in
    # Error.captureStackTrace on Linux. Pass a real Error until Bun fixes its
    # Node compatibility (oven-sh/bun#15750).
    substituteInPlace node_modules/follow-redirects/index.js \
      --replace-fail \
      'Error.captureStackTrace(this, this.constructor);' \
      'Error.captureStackTrace(new Error(), this.constructor);'

    mkdir -p "$out"
    cp -r . "$out"

    runHook postInstall
  '';

  meta = {
    description = "Extensions, skills, and themes for Pi Coding Agent";
    homepage = "https://github.com/zekurio/agent-stuff";
    license = lib.licenses.asl20;
    platforms = lib.platforms.unix;
  };
}
