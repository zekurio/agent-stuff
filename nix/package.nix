{
  buildNpmPackage,
  lib,
}:
buildNpmPackage {
  pname = "agent-stuff";
  version = (lib.importJSON ../package.json).version;

  src = lib.cleanSource ../.;

  npmDepsHash = "sha256-lOfu0vJQVqAeX+wAslh3sP0Xzt7D1Ov9c0XB20Rx3Hk=";
  npmInstallFlags = ["--ignore-scripts"];
  dontNpmBuild = true;
  doCheck = false;

  installPhase = ''
    runHook preInstall

    npm prune --omit=dev --ignore-scripts

    # Pi's bundled Bun runtime only accepts Error instances in
    # Error.captureStackTrace (oven-sh/bun#15750). Patch both dependencies
    # that pass another object. Axios otherwise masks every failed Firecrawl
    # request with "First argument must be an Error object".
    substituteInPlace node_modules/follow-redirects/index.js \
      --replace-fail \
      'Error.captureStackTrace(this, this.constructor);' \
      'Error.captureStackTrace(new Error(), this.constructor);'
    substituteInPlace \
      node_modules/axios/lib/core/Axios.js \
      node_modules/axios/dist/node/axios.cjs \
      --replace-fail \
      'let dummy = {};' \
      'let dummy = new Error();'

    mkdir -p "$out"
    cp -r . "$out"

    runHook postInstall
  '';

  meta = {
    description = "Extensions, skills, and themes for Pi Coding Agent";
    homepage = "https://github.com/zekurio/agent-stuff";
    license = lib.licenses.mit;
    platforms = lib.platforms.unix;
  };
}
