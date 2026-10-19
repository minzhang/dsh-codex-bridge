#!/usr/bin/env node
// Export the copyable bridge exactly as declared in development/delivery-files.json.
// Only Node built-ins are used, and the CLI roots are fixed to this repository.

import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const scriptPath = fileURLToPath(import.meta.url);
export const REPOSITORY_ROOT = resolve(dirname(scriptPath), '..', '..');

const DELIVERY_DIRECTORY = 'dsh-codex-bridge';
const ALLOWLIST_PATH = join('development', 'delivery-files.json');
const ARTIFACTS_DIRECTORY = '.artifacts';
const CHECKSUMS_FILE = 'SHA256SUMS.txt';

export class DeliveryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DeliveryError';
  }
}

function toPosix(path) {
  return path.split(sep).join('/');
}

function comparable(path) {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function samePath(left, right) {
  return comparable(resolve(left)) === comparable(resolve(right));
}

function lstatIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function nativeRealpath(path) {
  return typeof realpathSync.native === 'function' ? realpathSync.native(path) : realpathSync(path);
}

function assertNoReparsePoint(path, label) {
  const stats = lstatIfPresent(path);
  if (!stats) throw new DeliveryError(`${label} is missing: ${path}`);
  if (stats.isSymbolicLink()) {
    throw new DeliveryError(`${label} is a symlink or reparse point: ${path}`);
  }
  let resolved;
  try {
    resolved = nativeRealpath(path);
  } catch (error) {
    throw new DeliveryError(`${label} cannot be resolved: ${path} (${error.code || error.message})`);
  }
  if (!samePath(resolved, path)) {
    throw new DeliveryError(`${label} resolves through a symlink or reparse point: ${path}`);
  }
}

function assertPathInside(root, candidate, label) {
  const path = relative(resolve(root), resolve(candidate));
  if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new DeliveryError(`${label} must stay inside ${root}: ${candidate}`);
  }
}

function assertSafeRelativePath(entry) {
  if (typeof entry !== 'string' || entry.length === 0) {
    throw new DeliveryError('delivery-files.json must contain non-empty relative path strings');
  }
  if (entry !== entry.trim()) {
    throw new DeliveryError(`delivery-files.json path has surrounding whitespace: "${entry}"`);
  }
  if (isAbsolute(entry) || entry.includes('\\')) {
    throw new DeliveryError(`delivery-files.json path must use relative POSIX separators: "${entry}"`);
  }
  const segments = entry.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new DeliveryError(`delivery-files.json path is not normalized: "${entry}"`);
  }
  if (entry === '.state' || entry.startsWith('.state/')) {
    throw new DeliveryError(`delivery-files.json must not export local state: "${entry}"`);
  }
  return entry;
}

export function loadDeliveryFiles(repoRoot = REPOSITORY_ROOT) {
  const root = resolve(repoRoot);
  const allowlistPath = join(root, ALLOWLIST_PATH);
  assertNoReparsePoint(allowlistPath, 'Delivery allowlist');
  if (!lstatIfPresent(allowlistPath).isFile()) {
    throw new DeliveryError(`Delivery allowlist is not a regular file: ${allowlistPath}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(allowlistPath, 'utf8'));
  } catch (error) {
    throw new DeliveryError(`Cannot read delivery-files.json: ${error.message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new DeliveryError('delivery-files.json must be a non-empty JSON array');
  }

  const entries = parsed.map(assertSafeRelativePath);
  const unique = new Set(entries);
  if (unique.size !== entries.length) {
    throw new DeliveryError('delivery-files.json contains duplicate paths');
  }
  return Object.freeze(entries);
}

function collectSourceFiles(sourceRoot) {
  const files = [];

  function visit(directory, relativeDirectory) {
    const entries = readdirSync(directory, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      // Only the delivery root's .state directory is machine-local recovery evidence.
      if (relativeDirectory === '' && entry.name === '.state') continue;
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      const stats = lstatSync(absolutePath);
      if (stats.isSymbolicLink()) {
        throw new DeliveryError(`Delivery source contains a symlink or reparse point: ${absolutePath}`);
      }
      if (stats.isDirectory()) {
        assertNoReparsePoint(absolutePath, 'Delivery source directory');
        visit(absolutePath, relativePath);
        continue;
      }
      if (!stats.isFile()) {
        throw new DeliveryError(`Delivery source contains an unsupported entry: ${absolutePath}`);
      }
      assertNoReparsePoint(absolutePath, 'Delivery source file');
      files.push({ relativePath, absolutePath });
    }
  }

  visit(sourceRoot, '');
  files.sort((left, right) => (left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0));
  return files;
}

function validateSourceTree(repoRoot, allowlist) {
  const sourceRoot = join(repoRoot, DELIVERY_DIRECTORY);
  const sourceStats = lstatIfPresent(sourceRoot);
  if (!sourceStats) throw new DeliveryError(`Delivery source is missing: ${sourceRoot}`);
  if (sourceStats.isSymbolicLink() || !sourceStats.isDirectory()) {
    throw new DeliveryError(`Delivery source must be a real directory: ${sourceRoot}`);
  }
  assertNoReparsePoint(sourceRoot, 'Delivery source');

  const files = collectSourceFiles(sourceRoot);
  const actual = new Set(files.map((file) => file.relativePath));
  const expected = new Set(allowlist);
  const missing = allowlist.filter((entry) => !actual.has(entry));
  const unexpected = [...actual].filter((entry) => !expected.has(entry)).sort();
  if (missing.length > 0) {
    throw new DeliveryError(`Delivery source is missing allowlisted file(s): ${missing.join(', ')}`);
  }
  if (unexpected.length > 0) {
    throw new DeliveryError(`Delivery source contains unexpected file(s): ${unexpected.join(', ')}`);
  }
  return { sourceRoot, files };
}

function outputPaths(repoRoot) {
  const artifactsRoot = join(repoRoot, ARTIFACTS_DIRECTORY);
  return {
    artifactsRoot,
    finalDirectory: join(artifactsRoot, DELIVERY_DIRECTORY),
    checksumsPath: join(artifactsRoot, CHECKSUMS_FILE),
  };
}

function validateOutputLocation(repoRoot, paths) {
  if (!samePath(dirname(paths.artifactsRoot), repoRoot) || basename(paths.artifactsRoot) !== ARTIFACTS_DIRECTORY) {
    throw new DeliveryError(`Output must be written under ${join(repoRoot, ARTIFACTS_DIRECTORY)}`);
  }
  assertPathInside(paths.artifactsRoot, paths.finalDirectory, 'Delivery export');
  assertPathInside(paths.artifactsRoot, paths.checksumsPath, 'Checksums file');

  if (lstatIfPresent(paths.artifactsRoot)) {
    const artifactsStats = lstatSync(paths.artifactsRoot);
    if (artifactsStats.isSymbolicLink() || !artifactsStats.isDirectory()) {
      throw new DeliveryError(`Artifacts output is not a real directory: ${paths.artifactsRoot}`);
    }
    assertNoReparsePoint(paths.artifactsRoot, 'Artifacts output');
  }
  if (lstatIfPresent(paths.finalDirectory)) {
    throw new DeliveryError(`Refusing to overwrite existing export: ${paths.finalDirectory}`);
  }
  if (lstatIfPresent(paths.checksumsPath)) {
    throw new DeliveryError(`Refusing to overwrite existing checksums: ${paths.checksumsPath}`);
  }
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function inspectDelivery({ repoRoot = REPOSITORY_ROOT } = {}) {
  const root = resolve(repoRoot);
  if (!existsSync(root) || !lstatSync(root).isDirectory()) {
    throw new DeliveryError(`Repository root is not a directory: ${root}`);
  }
  const allowlist = loadDeliveryFiles(root);
  const { files } = validateSourceTree(root, allowlist);
  return {
    allowlist,
    files: files.map((file) => file.relativePath),
  };
}

export function packageDelivery({ repoRoot = REPOSITORY_ROOT } = {}) {
  const root = resolve(repoRoot);
  if (!existsSync(root) || !lstatSync(root).isDirectory()) {
    throw new DeliveryError(`Repository root is not a directory: ${root}`);
  }

  const allowlist = loadDeliveryFiles(root);
  const { sourceRoot, files } = validateSourceTree(root, allowlist);
  const paths = outputPaths(root);
  validateOutputLocation(root, paths);

  if (!lstatIfPresent(paths.artifactsRoot)) {
    mkdirSync(paths.artifactsRoot);
  }

  const stageName = `.stage-${process.pid}-${Date.now()}-${randomUUID()}`;
  const stageDirectory = join(paths.artifactsRoot, stageName);
  mkdirSync(stageDirectory);

  const checksumLines = [];
  for (const file of files) {
    const destination = join(stageDirectory, ...file.relativePath.split('/'));
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(file.absolutePath, destination);
    const sourceHash = hashFile(file.absolutePath);
    const exportedHash = hashFile(destination);
    if (sourceHash !== exportedHash) {
      throw new DeliveryError(`Exported bytes differ from source: ${file.relativePath}`);
    }
    checksumLines.push(`${exportedHash}  ${DELIVERY_DIRECTORY}/${file.relativePath}`);
  }

  const checksums = `${checksumLines.join('\n')}\n`;
  const temporaryChecksums = join(paths.artifactsRoot, `.${CHECKSUMS_FILE}.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(temporaryChecksums, checksums, 'utf8');

  // Rename the verified fresh stage into place; never delete or replace existing output.
  renameSync(stageDirectory, paths.finalDirectory);
  renameSync(temporaryChecksums, paths.checksumsPath);

  return {
    sourceRoot,
    finalDirectory: paths.finalDirectory,
    checksumsPath: paths.checksumsPath,
    files: files.map((file) => file.relativePath),
    checksums,
  };
}

function isCliEntryPoint() {
  if (!process.argv[1]) return false;
  return samePath(resolve(process.argv[1]), scriptPath);
}

if (isCliEntryPoint()) {
  try {
    const result = packageDelivery();
    const repositoryRelative = (path) => toPosix(relative(REPOSITORY_ROOT, path));
    process.stdout.write(`Exported ${result.files.length} delivery file(s) to ${repositoryRelative(result.finalDirectory)}\n`);
    process.stdout.write(`Wrote SHA-256 checksums to ${repositoryRelative(result.checksumsPath)}\n`);
  } catch (error) {
    process.stderr.write(`ERROR: ${error.message}\n`);
    process.exitCode = 1;
  }
}
