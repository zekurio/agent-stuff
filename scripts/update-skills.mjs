#!/usr/bin/env node

import {execFileSync} from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, isAbsolute, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(root, "upstreams/skills.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const args = process.argv.slice(2);
const check = args[0] === "--check";
const requested = check ? args.slice(1) : args;

if (requested.includes("--help") || requested.includes("-h")) {
  console.log("Usage: scripts/update-skills.mjs [--check] [skill ...]");
  process.exit(0);
}

const names = requested.length > 0 ? requested : Object.keys(manifest.skills);
for (const name of names) {
  if (!Object.hasOwn(manifest.skills, name)) {
    throw new Error(`Unknown vendored skill: ${name}`);
  }
}

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  }).trim();
}

function assertRelativePath(path, label) {
  if (isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
    throw new Error(`${label} must stay inside its base directory: ${path}`);
  }
}

function remoteRevision(entry) {
  const target = `refs/heads/${entry.ref}`;
  const output = git(["ls-remote", entry.repository, target]);
  const line = output.split("\n").find(Boolean);
  if (!line) throw new Error(`Could not resolve ${target} in ${entry.repository}`);
  return line.split(/\s+/)[0];
}

if (check) {
  let stale = false;
  for (const name of names) {
    const entry = manifest.skills[name];
    const latest = remoteRevision(entry);
    if (latest === entry.revision) {
      console.log(`${name}: current`);
    } else {
      stale = true;
      console.log(`${name}: update available`);
      console.log(`  ${entry.revision} -> ${latest}`);
    }
  }
  process.exitCode = stale ? 1 : 0;
} else {
  for (const name of names) updateSkill(name, manifest.skills[name]);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function updateSkill(name, entry) {
  assertRelativePath(entry.source, `${name}.source`);
  assertRelativePath(name, "skill name");

  const temporary = mkdtempSync(join(tmpdir(), `skill-${name}-`));
  const clone = join(temporary, "repository");
  const candidate = join(temporary, "candidate");

  try {
    const cloneArgs = [
      "clone",
      "--quiet",
      "--depth=1",
      "--filter=blob:none",
      "--no-checkout",
      "--branch",
      entry.ref,
      entry.repository,
      clone,
    ];
    try {
      git(cloneArgs);
    } catch {
      rmSync(clone, {recursive: true, force: true});
      git(cloneArgs.filter((argument) => argument !== "--filter=blob:none"));
    }

    const paths = [entry.source];
    for (const copy of entry.copies ?? []) {
      assertRelativePath(copy.source, `${name}.copies.source`);
      assertRelativePath(copy.destination, `${name}.copies.destination`);
      paths.push(copy.source);
    }
    git(["checkout", "HEAD", "--", ...paths], {cwd: clone});

    cpSync(join(clone, entry.source), candidate, {recursive: true});
    for (const copy of entry.copies ?? []) {
      cpSync(join(clone, copy.source), join(candidate, copy.destination), {
        recursive: true,
      });
    }

    if (entry.patch) {
      assertRelativePath(entry.patch, `${name}.patch`);
      git(
        ["apply", "--unsafe-paths", "--unidiff-zero", join(root, entry.patch)],
        {cwd: candidate},
      );
    }

    const destination = join(root, "skills", name);
    const stage = `${destination}.update-${process.pid}`;
    const backup = `${destination}.backup-${process.pid}`;
    rmSync(stage, {recursive: true, force: true});
    rmSync(backup, {recursive: true, force: true});
    cpSync(candidate, stage, {recursive: true});

    if (existsSync(destination)) renameSync(destination, backup);
    try {
      renameSync(stage, destination);
      rmSync(backup, {recursive: true, force: true});
    } catch (error) {
      rmSync(destination, {recursive: true, force: true});
      if (existsSync(backup)) renameSync(backup, destination);
      throw error;
    }

    entry.revision = git(["rev-parse", "HEAD"], {cwd: clone});
    console.log(`${name}: updated to ${entry.revision}`);
  } finally {
    rmSync(temporary, {recursive: true, force: true});
  }
}
