#!/usr/bin/env node
// Electron-as-Node bridge to the installed DSH Windows ACL backend.
//
// setup.ps1 starts this file with ELECTRON_RUN_AS_NODE=1 so Electron's patched
// fs can read resources/app.asar. It validates the installed package layout and
// public exports, derives the workspace SID dynamically, and applies the
// backend's ordinary standing workspace grant. It never invents ACL rules.

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const KNOWN_TESTED_VERSION = '0.2.1-rc.2';
const REQUIRED_EXPORTS = ['AclWriteGrant', 'workspaceWriteSid'];

function parseArguments(raw) {
  const options = {
    command: '',
    installDir: '',
    repo: '',
    root: '',
    result: '',
    extras: [],
  };
  for (let index = 0; index < raw.length; index += 1) {
    const token = raw[index];
    if (!options.command && !token.startsWith('--')) {
      options.command = token;
      continue;
    }
    if (token === '--extra') {
      const value = raw[index + 1];
      if (!value) throw new Error('missing value after --extra');
      options.extras.push(value);
      index += 1;
      continue;
    }
    const value = raw[index + 1];
    if (value === undefined) throw new Error(`missing value after ${token}`);
    switch (token) {
      case '--install-dir':
        options.installDir = value;
        break;
      case '--repo':
        options.repo = value;
        break;
      case '--root':
        options.root = value;
        break;
      case '--result':
        options.result = value;
        break;
      default:
        throw new Error(`unknown argument: ${token}`);
    }
    index += 1;
  }
  return options;
}

function canonicalDirectory(label, value) {
  if (!value) throw new Error(`${label} is required`);
  const full = resolve(value);
  if (!existsSync(full)) throw new Error(`${label} does not exist: ${full}`);
  const info = statSync(full);
  if (!info.isDirectory()) throw new Error(`${label} is not a directory: ${full}`);
  return realpathSync.native(full);
}

function hasReparseAncestor(root, target) {
  const rel = relative(root, target);
  if (rel.startsWith('..') || rel.split(sep).includes('..')) {
    throw new Error(`path is outside the repository: ${target}`);
  }
  let cursor = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part);
    const info = lstatSync(cursor);
    if (info.isSymbolicLink()) throw new Error(`reparse point/junction is not supported: ${cursor}`);
  }
}

function writeResult(path, payload) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const command = options.command;
  if (command !== 'info' && command !== 'grant') {
    throw new Error('command must be info or grant');
  }
  if (!options.result) throw new Error('--result is required');

  const repo = canonicalDirectory('--repo', options.repo);
  const root = canonicalDirectory('--root', options.root || options.repo);
  if (root.toLowerCase() !== repo.toLowerCase()) {
    throw new Error(`--root must be the canonical repository root (${repo}), got ${root}`);
  }
  if (!options.installDir) throw new Error('--install-dir is required');
  const installDir = resolve(options.installDir);
  const resources = resolve(installDir, 'resources');
  const packageDir = resolve(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-sandbox-windows-acl');
  const packageJsonPath = resolve(packageDir, 'package.json');
  const indexPath = resolve(packageDir, 'lib', 'index.js');
  if (!existsSync(packageJsonPath)) {
    throw new Error(`installed DSH sandbox package is missing: ${packageJsonPath}`);
  }
  if (!existsSync(indexPath)) {
    throw new Error(`installed DSH sandbox package entry point is missing: ${indexPath}`);
  }

  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  if (typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
    throw new Error(`installed DSH sandbox package has no version: ${packageJsonPath}`);
  }

  const backend = await import(pathToFileURL(indexPath).href);
  for (const name of REQUIRED_EXPORTS) {
    if (typeof backend[name] !== 'function' && typeof backend[name] !== 'object') {
      throw new Error(`installed DSH sandbox package does not export ${name} (version ${packageJson.version})`);
    }
  }
  if (typeof backend.workspaceWriteSid !== 'function') {
    throw new Error(`installed DSH sandbox workspaceWriteSid is not callable (version ${packageJson.version})`);
  }
  if (typeof backend.AclWriteGrant?.create !== 'function') {
    throw new Error(`installed DSH sandbox AclWriteGrant.create is not callable (version ${packageJson.version})`);
  }

  const writeSid = backend.workspaceWriteSid(repo);
  if (typeof writeSid !== 'string' || !/^S-1-4-\d+-\d+$/.test(writeSid)) {
    throw new Error(`installed DSH workspaceWriteSid returned an unexpected SID: ${String(writeSid)}`);
  }
  const base = {
    ok: true,
    command,
    installDir,
    packageDir,
    version: packageJson.version,
    knownTestedVersion: KNOWN_TESTED_VERSION,
    versionMatchesKnownTested: packageJson.version === KNOWN_TESTED_VERSION,
    repo,
    writeSid,
    exports: Object.keys(backend).sort(),
  };

  if (command === 'info') {
    writeResult(options.result, base);
    process.stdout.write(`${JSON.stringify(base)}\n`);
    return;
  }

  const extras = options.extras.map((value) => {
    const target = canonicalDirectory('--extra', value);
    hasReparseAncestor(repo, target);
    return target;
  });

  const grant = backend.AclWriteGrant.create(writeSid);
  const granted = [];
  let disposeError = null;
  try {
    grant.add(root, true);
    granted.push(root);
    for (const extra of extras) {
      grant.add(extra, true);
      granted.push(extra);
    }
  } finally {
    try {
      grant.dispose();
    } catch (error) {
      disposeError = error instanceof Error ? error : new Error(String(error));
    }
  }
  if (disposeError) {
    throw new Error(`DSH AclWriteGrant.dispose failed after applying the grant: ${disposeError.message}`);
  }

  const payload = {
    ...base,
    granted,
    standing: true,
  };
  writeResult(options.result, payload);
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

const resultPath = (() => {
  const index = process.argv.indexOf('--result');
  return index >= 0 ? process.argv[index + 1] : '';
})();

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const payload = {
    ok: false,
    error: {
      message,
      stack: error instanceof Error ? error.stack : undefined,
    },
  };
  try {
    writeResult(resultPath, payload);
  } catch (writeError) {
    process.stderr.write(`dsh-acl: could not write result file: ${writeError instanceof Error ? writeError.message : String(writeError)}\n`);
  }
  process.stderr.write(`dsh-acl: ${message}\n`);
  process.exitCode = 1;
}
