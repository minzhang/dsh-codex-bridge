#!/usr/bin/env node
// Canonical one-way implementation-report builder for the DSH/Codex bridge.
//
// This module owns the public run-result contract used by dsh-impl.ps1, the Markdown
// report, the terminal summary and the MCP server. It intentionally does not execute
// commands named by an implementer report, and it never reads claimed log contents.
//
// CLI:
//   node run-report.mjs manifest --design <path>
//   node run-report.mjs inventory --root <dir> --out <file> [--include <before.json>]
//   node run-report.mjs finalize --input <facts.json>

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCHEMA_VERSION = 1;
export const REPORT_HELPER_VERSION = '1';

const EXECUTION_STATUSES = ['SUCCEEDED', 'FAILED', 'TIMEOUT', 'LAUNCH_FAILED'];
const TASK_STATUSES = ['DONE', 'BLOCKED', 'PARTIAL', 'UNKNOWN'];
const IMPLEMENTER_STATUSES = ['DONE', 'BLOCKED', 'PARTIAL'];
const CHECK_STATUSES = ['PASS', 'FAIL', 'NOT_RUN', 'BLOCKED'];
const LOG_AVAILABILITY = ['PRESENT', 'MISSING', 'NOT_PROVIDED', 'UNSAFE'];
const REPORT_VALIDITY = ['VALID', 'INVALID', 'MISSING'];
const COVERAGE = ['COMPLETE', 'INCOMPLETE', 'NOT_DECLARED'];
const CLASSIFICATIONS = [
  'NEWLY_CHANGED',
  'PREEXISTING_CHANGED',
  'PREEXISTING_UNCHANGED',
  'UNKNOWN',
];

const ACCEPTANCE_START = '<!-- dsh-acceptance-start -->';
const ACCEPTANCE_END = '<!-- dsh-acceptance-end -->';

const RESULT_NAME_PATTERN = /^(\d{8}-\d{6}-[0-9a-f]{8})-result\.json$/;
const RUN_ID_PATTERN = /^\d{8}-\d{6}-[0-9a-f]{8}$/;

// --------------------------------------------------------------------------- small utilities

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asStringArray(value) {
  if (Array.isArray(value)) return value.filter((entry) => typeof entry === 'string');
  if (typeof value === 'string' && value.length > 0) return [value];
  return [];
}

function roundDuration(milliseconds) {
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? Math.round(milliseconds) : 0;
}

function toIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function slashPath(value) {
  return String(value).replaceAll('\\', '/');
}

function artifactPath(repoRoot, absoluteOrRelative) {
  if (!absoluteOrRelative) return null;
  const absolute = isAbsolute(absoluteOrRelative)
    ? resolve(absoluteOrRelative)
    : resolve(repoRoot, absoluteOrRelative);
  const rel = relative(repoRoot, absolute);
  if (rel === '') return '.';
  if (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
    return slashPath(rel);
  }
  return slashPath(absolute);
}

function normalizeSeparators(value) {
  return value.trim().replaceAll('\\', '/');
}

function normalizeCommand(value) {
  // Commands are the implementer's claim of exact executable text. Only surrounding
  // whitespace is ignorable; arguments, quoted text, URLs and separators are not rewritten.
  return value.trim();
}

function normalizeCwd(value) {
  let normalized = value.trim().replaceAll('\\', '/');
  if (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  return normalized;
}

function safeRepoRelative(value, { allowRoot = false } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) return null;
  const normalized = normalizeSeparators(value);
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return null;
  const parts = normalized.split('/');
  if (parts.some((part) => part === '..')) return null;
  if (!allowRoot && normalized === '.') return null;
  if (normalized === '.') return '.';
  const cleaned = parts.filter((part) => part !== '' && part !== '.').join('/');
  if (cleaned === '') return allowRoot ? '.' : null;
  return cleaned;
}

function resolveInside(root, relativePath) {
  const absolute = resolve(root, relativePath);
  const rel = relative(root, absolute);
  if (rel !== '' && (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))) {
    return null;
  }
  return absolute;
}

function atomicWrite(filePath, contents) {
  const directory = dirname(filePath);
  mkdirSync(directory, { recursive: true });
  const temporary = join(
    directory,
    `.${basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    writeFileSync(temporary, contents, 'utf8');
    try {
      renameSync(temporary, filePath);
    } catch {
      // Windows does not always replace an existing file on rename.
      try {
        rmSync(filePath, { force: true });
      } catch {}
      renameSync(temporary, filePath);
    }
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {}
    throw error;
  }
}

function writeJsonAtomic(filePath, value) {
  atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatTokens(tokens) {
  if (!tokens) return 'not reported';
  return `${Number(tokens.input).toLocaleString('en-US')} in / ${Number(tokens.output).toLocaleString('en-US')} out tokens`;
}

function markdownCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\r', ' ').replaceAll('\n', ' ');
}

function truncate(value, max = 240) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

// --------------------------------------------------------------------------- acceptance manifest

export function parseAcceptanceManifest(designText) {
  const startIndex = designText.indexOf(ACCEPTANCE_START);
  const endIndex = designText.indexOf(ACCEPTANCE_END);
  if (startIndex < 0 && endIndex < 0) {
    return { declared: false, checks: [] };
  }
  if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) {
    throw new Error(
      'design acceptance manifest markers are incomplete: both <!-- dsh-acceptance-start --> and <!-- dsh-acceptance-end --> are required',
    );
  }
  if (designText.indexOf(ACCEPTANCE_START, startIndex + ACCEPTANCE_START.length) >= 0) {
    throw new Error('design acceptance manifest must contain exactly one start marker');
  }
  if (designText.indexOf(ACCEPTANCE_END, endIndex + ACCEPTANCE_END.length) >= 0) {
    throw new Error('design acceptance manifest must contain exactly one end marker');
  }
  const body = designText.slice(startIndex + ACCEPTANCE_START.length, endIndex).trim();
  if (!body) {
    throw new Error('design acceptance manifest is empty; expected a JSON array');
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new Error(`design acceptance manifest is not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('design acceptance manifest must be a JSON array');
  }
  const ids = new Set();
  const checks = [];
  for (const [index, entry] of parsed.entries()) {
    if (!isPlainObject(entry)) {
      throw new Error(`design acceptance manifest entry ${index} must be a JSON object`);
    }
    for (const key of ['id', 'command', 'cwd']) {
      if (typeof entry[key] !== 'string' || entry[key].length === 0) {
        throw new Error(`design acceptance manifest entry ${index} must have a non-empty string "${key}"`);
      }
    }
    if (ids.has(entry.id)) {
      throw new Error(`design acceptance manifest contains duplicate check id "${entry.id}"`);
    }
    ids.add(entry.id);
    checks.push({ id: entry.id, command: entry.command, cwd: entry.cwd });
  }
  return { declared: true, checks };
}

// --------------------------------------------------------------------------- Git inventory

function runGit(root, args) {
  // File-backed stdio is required on the DSH Windows sandbox, where Node piping a
  // child process can fail with EPERM. The unique capture directory is ours.
  const captureDirectory = mkdtempSync(join(tmpdir(), 'dsh-report-git-'));
  const stdoutPath = join(captureDirectory, 'stdout');
  const stderrPath = join(captureDirectory, 'stderr');
  let stdoutFd;
  let stderrFd;
  try {
    stdoutFd = openSync(stdoutPath, 'w');
    stderrFd = openSync(stderrPath, 'w');
    const result = spawnSync('git', ['-C', root, ...args], {
      stdio: ['ignore', stdoutFd, stderrFd],
      windowsHide: true,
    });
    closeSync(stdoutFd);
    stdoutFd = undefined;
    closeSync(stderrFd);
    stderrFd = undefined;
    return {
      status: result.status,
      stdout: readFileSync(stdoutPath),
      stderr: readFileSync(stderrPath),
      error: result.error,
    };
  } catch (error) {
    return { status: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error };
  } finally {
    if (stdoutFd !== undefined) {
      try {
        closeSync(stdoutFd);
      } catch {}
    }
    if (stderrFd !== undefined) {
      try {
        closeSync(stderrFd);
      } catch {}
    }
    try {
      rmSync(captureDirectory, { recursive: true, force: true });
    } catch {}
  }
}

function hashFile(filePath) {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const fd = openSync(filePath, flags);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      return { sha256: null, type: stat.isDirectory() ? 'directory' : 'other' };
    }
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, position);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
      position += read;
    }
    return { sha256: hash.digest('hex'), type: 'file' };
  } finally {
    closeSync(fd);
  }
}

function sameCanonicalPath(left, right) {
  if (process.platform === 'win32') {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

function inspectPathAncestors(root, relativePath, warnings) {
  const parts = relativePath.split('/');
  let realRoot;
  try {
    realRoot = realpathSync.native(root);
  } catch (error) {
    warnings.push(`could not resolve repository root for ${relativePath}: ${error.code ?? error.message}`);
    return 'unsafe';
  }
  let current = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    current = join(current, parts[index]);
    const expected = join(realRoot, ...parts.slice(0, index + 1));
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
        return 'missing';
      }
      warnings.push(`could not inspect a parent of ${relativePath}: ${error.code ?? error.message}`);
      return 'unsafe';
    }
    if (stat.isSymbolicLink()) {
      warnings.push(`path contains a link/reparse ancestor and was not inspected: ${relativePath}`);
      return 'unsafe';
    }
    if (!stat.isDirectory()) {
      warnings.push(`path ancestor is not a directory and was not inspected: ${relativePath}`);
      return 'unsafe';
    }
    let realCurrent;
    try {
      realCurrent = realpathSync.native(current);
    } catch (error) {
      warnings.push(`could not resolve a parent of ${relativePath}: ${error.code ?? error.message}`);
      return 'unsafe';
    }
    // Node reports Windows junctions as directories rather than symlinks; comparing the
    // resolved ancestor with the logical repository-relative path detects those reparse
    // points (and any other link form) before any content read.
    if (!sameCanonicalPath(realCurrent, expected)) {
      warnings.push(`path contains a link/reparse ancestor and was not inspected: ${relativePath}`);
      return 'unsafe';
    }
  }
  return 'ok';
}

function describePath(root, relativePath, warnings) {
  const absolute = resolveInside(root, relativePath);
  if (!absolute) {
    warnings.push(`path escaped the repository while taking inventory: ${relativePath}`);
    return {
      type: 'unknown',
      present: null,
      sha256: null,
      linkIdentity: null,
      unsafe: true,
    };
  }
  const ancestorStatus = inspectPathAncestors(root, relativePath, warnings);
  if (ancestorStatus === 'missing') {
    return { type: 'missing', present: false, sha256: null, linkIdentity: null, unsafe: false };
  }
  if (ancestorStatus === 'unsafe') {
    return { type: 'unknown', present: null, sha256: null, linkIdentity: null, unsafe: true };
  }
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      return { type: 'missing', present: false, sha256: null, linkIdentity: null, unsafe: false };
    }
    warnings.push(`could not inspect ${relativePath}: ${error.code ?? error.message}`);
    return { type: 'unknown', present: null, sha256: null, linkIdentity: null, unsafe: false };
  }
  if (stat.isSymbolicLink()) {
    let identity = 'unknown';
    try {
      identity = readlinkSync(absolute);
    } catch (error) {
      warnings.push(`could not read link identity for ${relativePath}: ${error.code ?? error.message}`);
    }
    return { type: 'link', present: true, sha256: null, linkIdentity: identity, unsafe: false };
  }
  if (stat.isFile()) {
    try {
      const hashed = hashFile(absolute);
      return {
        type: hashed.type,
        present: true,
        sha256: hashed.sha256,
        linkIdentity: null,
        unsafe: false,
      };
    } catch (error) {
      warnings.push(`could not hash ${relativePath}: ${error.code ?? error.message}`);
      return { type: 'file', present: true, sha256: null, linkIdentity: null, unsafe: false };
    }
  }
  return {
    type: stat.isDirectory() ? 'directory' : 'other',
    present: true,
    sha256: null,
    linkIdentity: null,
    unsafe: false,
  };
}

function readIndexEntries(root, paths, warnings) {
  const entries = new Map();
  if (paths.length === 0) return entries;
  const chunks = [];
  for (let index = 0; index < paths.length; index += 50) {
    chunks.push(paths.slice(index, index + 50));
  }
  for (const chunk of chunks) {
    const result = runGit(
      root,
      ['ls-files', '-s', '-z', '--', ...chunk.map((item) => `:(literal)${item}`)],
    );
    if (result.status !== 0) {
      const message = result.error?.message || result.stderr?.toString('utf8').trim() || `exit ${result.status}`;
      warnings.push(`could not read index entries: ${message}`);
      continue;
    }
    for (const record of result.stdout.toString('utf8').split('\0')) {
      if (!record) continue;
      const tab = record.indexOf('\t');
      if (tab < 0) continue;
      const meta = record.slice(0, tab).split(' ');
      const path = record.slice(tab + 1);
      entries.set(path, {
        indexMode: meta[0] ?? null,
        indexSha: meta[1] ?? null,
        indexStage: meta[2] ?? null,
      });
    }
  }
  return entries;
}

function parsePorcelain(root, warnings) {
  const result = runGit(root, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--no-renames',
  ]);
  if (result.status !== 0) {
    const message = result.error?.message || result.stderr?.toString('utf8').trim() || `exit ${result.status}`;
    throw new Error(`git status failed: ${message}`);
  }
  const records = result.stdout.toString('utf8').split('\0');
  const entries = [];
  for (const record of records) {
    if (!record) continue;
    if (record.length < 4 || record[2] !== ' ') {
      warnings.push('git status returned an unrecognized record; it was skipped');
      continue;
    }
    entries.push({
      status: record.slice(0, 2),
      indexStatus: record[0] === ' ' || record[0] === '?' ? null : record[0],
      worktreeStatus: record[1] === ' ' || record[1] === '?' ? null : record[1],
      path: slashPath(record.slice(3)),
    });
  }
  return entries;
}

export function takeInventory(root) {
  const warnings = [];
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return {
      schemaVersion: 1,
      status: 'UNAVAILABLE',
      reason: `repository root is not a directory: ${root}`,
      head: null,
      paths: [],
      warnings,
    };
  }
  const inside = runGit(root, ['rev-parse', '--is-inside-work-tree']);
  if (inside.error) {
    return {
      schemaVersion: 1,
      status: 'UNAVAILABLE',
      reason: `Git is unavailable: ${inside.error.message}`,
      head: null,
      paths: [],
      warnings,
    };
  }
  if (inside.status !== 0 || String(inside.stdout).trim() !== 'true') {
    return {
      schemaVersion: 1,
      status: 'UNAVAILABLE',
      reason: 'not a Git repository',
      head: null,
      paths: [],
      warnings,
    };
  }
  const headResult = runGit(root, ['rev-parse', 'HEAD']);
  const head = headResult.status === 0 ? String(headResult.stdout).trim() : null;
  let dirtyEntries;
  try {
    dirtyEntries = parsePorcelain(root, warnings);
  } catch (error) {
    warnings.push(error.message);
    return {
      schemaVersion: 1,
      status: 'UNAVAILABLE',
      reason: 'Git status could not be read',
      head,
      paths: [],
      warnings,
    };
  }
  const byPath = new Map();
  for (const entry of dirtyEntries) {
    if (byPath.has(entry.path)) {
      warnings.push(`duplicate Git status path was ignored: ${entry.path}`);
      continue;
    }
    byPath.set(entry.path, entry);
  }
  const indexEntries = readIndexEntries(root, [...byPath.keys()], warnings);
  const paths = [];
  for (const [path, entry] of byPath) {
    const description = describePath(root, path, warnings);
    const index = indexEntries.get(path) ?? {};
    paths.push({
      path,
      status: entry.status,
      indexStatus: entry.indexStatus,
      worktreeStatus: entry.worktreeStatus,
      present: description.present,
      type: description.type,
      sha256: description.sha256,
      linkIdentity: description.linkIdentity,
      unsafe: description.unsafe === true,
      indexMode: index.indexMode ?? null,
      indexSha: index.indexSha ?? null,
      indexStage: index.indexStage ?? null,
    });
  }
  paths.sort((left, right) => left.path.localeCompare(right.path));
  return {
    schemaVersion: 1,
    status: 'OBSERVED',
    reason: null,
    head,
    paths,
    warnings,
  };
}

export function readInventory(filePath) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!isPlainObject(parsed) || parsed.schemaVersion !== 1) {
      throw new Error('unsupported inventory schema');
    }
    return parsed;
  } catch (error) {
    const reason = `inventory could not be read: ${error.message}`;
    return {
      schemaVersion: 1,
      status: 'UNAVAILABLE',
      reason,
      head: null,
      paths: [],
      warnings: [reason],
    };
  }
}

function addAdditionalCleanPaths(after, before) {
  if (!isPlainObject(after) || after.status !== 'OBSERVED') return;
  if (!isPlainObject(before) || before.status !== 'OBSERVED') return;
  const existing = new Set(after.paths.map((entry) => entry.path));
  const warnings = [];
  for (const prior of before.paths) {
    if (existing.has(prior.path)) continue;
    const description = describePath(after.rootForInventory, prior.path, warnings);
    after.paths.push({
      path: prior.path,
      status: '',
      indexStatus: null,
      worktreeStatus: null,
      present: description.present,
      type: description.type,
      sha256: description.sha256,
      linkIdentity: description.linkIdentity,
      unsafe: description.unsafe === true,
      indexMode: null,
      indexSha: null,
      indexStage: null,
    });
  }
  if (after.paths.some((entry) => entry.path === undefined)) {
    after.paths = after.paths.filter((entry) => entry.path !== undefined);
  }
  after.warnings.push(...warnings);
}

function classifyEntry(before, after) {
  if (before?.unsafe === true || after?.unsafe === true) {
    return { classification: 'UNKNOWN', changeKinds: ['UNSAFE_PATH'] };
  }
  const beforeDirty = Boolean(before && before.status !== '');
  const afterDirty = Boolean(after && after.status !== '');
  const changeKinds = [];
  if (!beforeDirty && afterDirty) {
    if (after.status === '??') changeKinds.push('UNTRACKED');
    else if (after.status.includes('D')) changeKinds.push('DELETED');
    else if (after.status.includes('A')) changeKinds.push('ADDED');
    else changeKinds.push('MODIFIED');
    if (after.indexStatus) changeKinds.push('STAGED');
    return { classification: 'NEWLY_CHANGED', changeKinds };
  }
  if (beforeDirty && !afterDirty) {
    if (after && after.present && after.status === '') {
      changeKinds.push('RESTORED_TO_HEAD');
    } else if (after && after.present === false) {
      changeKinds.push('DELETED');
    } else {
      changeKinds.push('NO_LONGER_DIRTY');
    }
    return { classification: 'PREEXISTING_CHANGED', changeKinds };
  }
  if (!beforeDirty && !afterDirty) {
    return { classification: 'PREEXISTING_UNCHANGED', changeKinds: ['UNCHANGED'] };
  }

  const comparable =
    before.sha256 !== null &&
    after.sha256 !== null &&
    before.sha256 !== undefined &&
    after.sha256 !== undefined;
  const linkComparable =
    before.type === 'link' &&
    after.type === 'link' &&
    before.linkIdentity !== 'unknown' &&
    after.linkIdentity !== 'unknown';
  const changed =
    before.status !== after.status ||
    before.indexStatus !== after.indexStatus ||
    before.worktreeStatus !== after.worktreeStatus ||
    before.indexSha !== after.indexSha ||
    before.indexMode !== after.indexMode ||
    before.present !== after.present ||
    before.type !== after.type ||
    (comparable && before.sha256 !== after.sha256) ||
    (linkComparable && before.linkIdentity !== after.linkIdentity);

  if (!comparable && !linkComparable && before.present !== false && after.present !== false) {
    return { classification: 'UNKNOWN', changeKinds: ['UNCOMPARABLE_CONTENT'] };
  }
  if (changed) {
    if (before.sha256 !== null && after.sha256 !== null && before.sha256 !== after.sha256) {
      changeKinds.push('CONTENT_CHANGED');
    }
    if (before.indexSha !== after.indexSha || before.status !== after.status) {
      changeKinds.push('INDEX_OR_STATUS_CHANGED');
    }
    if (changeKinds.length === 0) changeKinds.push('CHANGED');
    return { classification: 'PREEXISTING_CHANGED', changeKinds };
  }
  return { classification: 'PREEXISTING_UNCHANGED', changeKinds: ['UNCHANGED'] };
}

export function compareInventories(before, after) {
  const warnings = [];
  if (before.status !== 'OBSERVED' || after.status !== 'OBSERVED') {
    const reasons = [];
    if (before.status !== 'OBSERVED') reasons.push(`before: ${before.reason ?? 'unavailable'}`);
    if (after.status !== 'OBSERVED') reasons.push(`after: ${after.reason ?? 'unavailable'}`);
    return {
      status: 'UNAVAILABLE',
      reason: reasons.join('; '),
      headBefore: before.head ?? null,
      headAfter: after.head ?? null,
      paths: [],
      warnings,
    };
  }
  const beforeMap = new Map(before.paths.map((entry) => [entry.path, entry]));
  const afterMap = new Map(after.paths.map((entry) => [entry.path, entry]));
  const union = new Set([...beforeMap.keys(), ...afterMap.keys()]);
  const paths = [];
  for (const path of [...union].sort((left, right) => left.localeCompare(right))) {
    const beforeEntry = beforeMap.get(path);
    const afterEntry = afterMap.get(path);
    if (!beforeEntry || !afterEntry) {
      if (!beforeEntry && !afterEntry) continue;
    }
    const { classification, changeKinds } = classifyEntry(beforeEntry, afterEntry);
    if (
      !beforeEntry?.status &&
      !afterEntry?.status &&
      classification === 'PREEXISTING_UNCHANGED'
    ) {
      continue;
    }
    paths.push({
      path,
      classification,
      changeKinds,
      statusBefore: beforeEntry?.status || null,
      statusAfter: afterEntry?.status || null,
      indexStatusBefore: beforeEntry?.indexStatus ?? null,
      indexStatusAfter: afterEntry?.indexStatus ?? null,
      worktreeStatusBefore: beforeEntry?.worktreeStatus ?? null,
      worktreeStatusAfter: afterEntry?.worktreeStatus ?? null,
      sha256Before: beforeEntry?.sha256 ?? null,
      sha256After: afterEntry?.sha256 ?? null,
      indexShaBefore: beforeEntry?.indexSha ?? null,
      indexShaAfter: afterEntry?.indexSha ?? null,
      indexModeBefore: beforeEntry?.indexMode ?? null,
      indexModeAfter: afterEntry?.indexMode ?? null,
      linkIdentityBefore: beforeEntry?.linkIdentity ?? null,
      linkIdentityAfter: afterEntry?.linkIdentity ?? null,
      unsafeBefore: beforeEntry?.unsafe === true,
      unsafeAfter: afterEntry?.unsafe === true,
      typeBefore: beforeEntry?.type ?? null,
      typeAfter: afterEntry?.type ?? null,
      presentBefore: beforeEntry?.present ?? null,
      presentAfter: afterEntry?.present ?? null,
    });
  }
  const counts = Object.fromEntries(CLASSIFICATIONS.map((name) => [name, 0]));
  for (const entry of paths) counts[entry.classification] += 1;
  return {
    status: 'OBSERVED',
    reason: null,
    headBefore: before.head ?? null,
    headAfter: after.head ?? null,
    counts,
    paths,
    warnings,
  };
}

// --------------------------------------------------------------------------- event stream

export function parseEventStream(eventsPath, requestedSession) {
  const parsed = {
    events: [],
    sessionId: null,
    sessionProvenance: null,
    finalText: '',
    finalEventPresent: false,
    errorText: null,
    turnEnd: null,
    toolCalls: 0,
    toolErrors: 0,
    tokens: null,
    malformedLineNumbers: [],
    lastValidEvent: null,
    captureErrors: [],
  };
  let raw;
  try {
    raw = readFileSync(eventsPath, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  } catch (error) {
    parsed.captureErrors.push(`event stream could not be read: ${error.code ?? error.message}`);
    if (requestedSession) {
      parsed.sessionId = requestedSession;
      parsed.sessionProvenance = 'REQUESTED_FALLBACK';
    }
    return parsed;
  }
  const lines = raw.split(/\r?\n/);
  let inputTokens = 0;
  let outputTokens = 0;
  let usageSeen = false;
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      parsed.malformedLineNumbers.push(index + 1);
      continue;
    }
    if (!isPlainObject(event) || typeof event.type !== 'string' || event.type.length === 0) {
      parsed.malformedLineNumbers.push(index + 1);
      continue;
    }
    parsed.events.push(event);
    parsed.lastValidEvent = {
      type: event.type,
      phase: typeof event.phase === 'string' ? event.phase : null,
    };
    if (event.type === 'session' && typeof event.sessionId === 'string' && event.sessionId.length > 0) {
      if (!parsed.sessionId) {
        parsed.sessionId = event.sessionId;
        parsed.sessionProvenance = 'EVENT';
      }
    }
    if (event.type === 'final' && typeof event.text === 'string') {
      parsed.finalText = event.text;
      parsed.finalEventPresent = true;
    }
    if (event.type === 'error' && typeof event.message === 'string') {
      parsed.errorText = event.message;
    }
    if (event.type === 'status' && event.phase === 'turn_end') {
      const reason = event.reason;
      let kind = null;
      let message = null;
      if (isPlainObject(reason)) {
        if (typeof reason.kind === 'string') kind = reason.kind;
        if (isPlainObject(reason.error) && typeof reason.error.message === 'string') {
          message = reason.error.message;
        }
      } else if (typeof reason === 'string') {
        kind = reason;
      }
      parsed.turnEnd = { reason: kind, error: message };
    }
    if (event.type === 'tool_call') parsed.toolCalls += 1;
    if (event.type === 'tool_result' && event.status === 'error') parsed.toolErrors += 1;
    if (event.type === 'status' && event.phase === 'step_end' && isPlainObject(event.usage)) {
      if (Number.isFinite(event.usage.inputTokens) || Number.isFinite(event.usage.outputTokens)) {
        usageSeen = true;
        if (Number.isFinite(event.usage.inputTokens)) inputTokens += event.usage.inputTokens;
        if (Number.isFinite(event.usage.outputTokens)) outputTokens += event.usage.outputTokens;
      }
    }
  }
  if (usageSeen) parsed.tokens = { input: inputTokens, output: outputTokens };
  if (!parsed.sessionId && requestedSession) {
    parsed.sessionId = requestedSession;
    parsed.sessionProvenance = 'REQUESTED_FALLBACK';
  }
  return parsed;
}

// --------------------------------------------------------------------------- report validation

function validateReportPaths(repoRoot, task, errors, warnings) {
  for (const [index, change] of task.changes.entries()) {
    if (!safeRepoRelative(change.path)) {
      errors.push(`changes[${index}].path must be a repository-relative path that does not escape: ${change.path}`);
    }
  }
  for (const [index, check] of task.checks.entries()) {
    if (!safeRepoRelative(check.cwd, { allowRoot: true })) {
      errors.push(`checks[${index}].cwd must be a repository-relative directory that does not escape: ${check.cwd}`);
    }
    if (check.logPath !== null && !safeRepoRelative(check.logPath)) {
      errors.push(`checks[${index}].logPath must be a repository-relative path that does not escape: ${check.logPath}`);
    }
    if (check.logPath !== null) {
      const safe = safeRepoRelative(check.logPath);
      if (!safe) {
        check.logAvailability = 'UNSAFE';
      } else {
        check.logAvailability = logAvailability(repoRoot, safe);
      }
    } else {
      check.logAvailability = 'NOT_PROVIDED';
    }
  }
  return warnings;
}

function logAvailability(repoRoot, relativePath) {
  const parts = relativePath.split('/');
  let current = repoRoot;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
        return index === parts.length - 1 ? 'MISSING' : 'MISSING';
      }
      return 'UNSAFE';
    }
    if (stat.isSymbolicLink()) return 'UNSAFE';
    if (index < parts.length - 1 && !stat.isDirectory()) return 'UNSAFE';
    if (index === parts.length - 1 && !stat.isFile()) return 'UNSAFE';
  }
  const absolute = resolveInside(repoRoot, relativePath);
  if (!absolute) return 'UNSAFE';
  try {
    const realRoot = realpathSync.native(repoRoot);
    const realFile = realpathSync.native(absolute);
    const rel = relative(realRoot, realFile);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return 'UNSAFE';
  } catch {
    return 'UNSAFE';
  }
  return 'PRESENT';
}

function emptyTask() {
  return {
    status: 'UNKNOWN',
    claimedStatus: null,
    summary: '',
    changes: [],
    checks: [],
    decisions: [],
    followUps: [],
  };
}

function validateCheckEntry(entry, index, errors) {
  if (!isPlainObject(entry)) {
    errors.push(`checks[${index}] must be an object`);
    return null;
  }
  const required = ['id', 'command', 'cwd', 'status', 'exitCode', 'logPath', 'reason'];
  for (const key of required) {
    if (!Object.hasOwn(entry, key)) {
      errors.push(`checks[${index}] is missing required key "${key}"`);
    }
  }
  let usable = true;
  if (typeof entry.id !== 'string' || entry.id.length === 0) {
    errors.push(`checks[${index}].id must be a non-empty string`);
    usable = false;
  }
  if (typeof entry.command !== 'string' || entry.command.length === 0) {
    errors.push(`checks[${index}].command must be a non-empty string`);
    usable = false;
  }
  if (typeof entry.cwd !== 'string' || entry.cwd.length === 0) {
    errors.push(`checks[${index}].cwd must be a non-empty string`);
    usable = false;
  }
  if (!CHECK_STATUSES.includes(entry.status)) {
    errors.push(`checks[${index}].status must be one of: ${CHECK_STATUSES.join(', ')}`);
    usable = false;
  }
  if (!(entry.exitCode === null || Number.isInteger(entry.exitCode))) {
    errors.push(`checks[${index}].exitCode must be an integer or null`);
    usable = false;
  }
  if (!(entry.logPath === null || (typeof entry.logPath === 'string' && entry.logPath.length > 0))) {
    errors.push(`checks[${index}].logPath must be a non-empty relative string or null`);
    usable = false;
  }
  if (typeof entry.reason !== 'string') {
    errors.push(`checks[${index}].reason must be a string`);
    usable = false;
  }
  if (!usable) return null;
  if (entry.status === 'PASS' && entry.exitCode !== 0) {
    errors.push(`checks[${index}] status PASS requires exitCode 0`);
  }
  if (entry.status === 'FAIL' && !(Number.isInteger(entry.exitCode) && entry.exitCode !== 0)) {
    errors.push(`checks[${index}] status FAIL requires a nonzero integer exitCode`);
  }
  if ((entry.status === 'NOT_RUN' || entry.status === 'BLOCKED') && entry.exitCode !== null) {
    errors.push(`checks[${index}] status ${entry.status} requires exitCode null`);
  }
  if (
    (entry.status === 'NOT_RUN' || entry.status === 'BLOCKED') &&
    entry.reason.trim().length === 0
  ) {
    errors.push(`checks[${index}] status ${entry.status} requires a non-empty reason`);
  }
  return {
    id: entry.id,
    command: entry.command,
    cwd: entry.cwd,
    status: entry.status,
    exitCode: entry.exitCode,
    logPath: entry.logPath,
    reason: entry.reason,
    source: 'IMPLEMENTER',
    logAvailability: 'NOT_PROVIDED',
    additional: false,
  };
}

export function parseImplementerReport(finalText, { repoRoot, manifest }) {
  const errors = [];
  const warnings = [];
  const rawText = typeof finalText === 'string' ? finalText : '';
  const declaredChecks = manifest?.declared ? manifest.checks : [];
  const result = {
    validity: 'INVALID',
    errors,
    warnings,
    rawText,
    legacyStatus: false,
    claimedStatus: null,
    task: emptyTask(),
    acceptance: {
      expectedCheckIds: declaredChecks.map((check) => check.id),
      missingCheckIds: declaredChecks.map((check) => check.id),
      additionalCheckIds: [],
      coverage: manifest?.declared ? 'INCOMPLETE' : 'NOT_DECLARED',
    },
  };
  const trimmed = rawText.trim();
  if (trimmed.length === 0) {
    result.validity = 'MISSING';
    errors.push('the implementer final message was empty or absent');
    return result;
  }
  if (/^```/.test(trimmed)) {
    errors.push('final message must be a single JSON object without Markdown code fences');
    return result;
  }
  if (/^STATUS\s*:/i.test(trimmed)) {
    result.legacyStatus = true;
    errors.push(
      'legacy STATUS prose is not accepted; return one JSON object with schemaVersion 1 and status DONE/BLOCKED/PARTIAL',
    );
    return result;
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    errors.push(`final message is not valid JSON: ${error.message}`);
    if (/\bSTATUS\s*:/i.test(trimmed)) {
      result.legacyStatus = true;
      warnings.push(
        'the response resembles the legacy STATUS prose format; use the JSON implementer contract instead',
      );
    }
    return result;
  }
  if (!isPlainObject(parsed)) {
    errors.push('final message must be a JSON object');
    return result;
  }
  const required = [
    'schemaVersion',
    'status',
    'summary',
    'changes',
    'checks',
    'decisions',
    'followUps',
  ];
  for (const key of required) {
    if (!Object.hasOwn(parsed, key)) errors.push(`final message is missing required key "${key}"`);
  }
  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`unsupported schemaVersion: ${JSON.stringify(parsed.schemaVersion)}; expected numeric 1`);
  }
  if (!IMPLEMENTER_STATUSES.includes(parsed.status)) {
    errors.push(`status must be one of: ${IMPLEMENTER_STATUSES.join(', ')}`);
  } else {
    result.claimedStatus = parsed.status;
  }
  if (typeof parsed.summary !== 'string') errors.push('summary must be a string');
  if (!Array.isArray(parsed.changes)) {
    errors.push('changes must be an array');
  }
  if (!Array.isArray(parsed.checks)) {
    errors.push('checks must be an array');
  }
  if (!Array.isArray(parsed.decisions) || parsed.decisions.some((value) => typeof value !== 'string')) {
    errors.push('decisions must be an array of strings');
  }
  if (!Array.isArray(parsed.followUps) || parsed.followUps.some((value) => typeof value !== 'string')) {
    errors.push('followUps must be an array of strings');
  }

  const task = emptyTask();
  task.claimedStatus = result.claimedStatus;
  if (typeof parsed.summary === 'string') task.summary = parsed.summary;

  if (Array.isArray(parsed.changes)) {
    for (const [index, change] of parsed.changes.entries()) {
      if (!isPlainObject(change)) {
        errors.push(`changes[${index}] must be an object`);
        continue;
      }
      if (typeof change.path !== 'string' || change.path.length === 0) {
        errors.push(`changes[${index}].path must be a non-empty string`);
        continue;
      }
      if (typeof change.description !== 'string') {
        errors.push(`changes[${index}].description must be a string`);
        continue;
      }
      task.changes.push({ path: change.path, description: change.description });
    }
  }

  const ids = new Set();
  if (Array.isArray(parsed.checks)) {
    for (const [index, entry] of parsed.checks.entries()) {
      const check = validateCheckEntry(entry, index, errors);
      if (!check) continue;
      if (ids.has(check.id)) {
        errors.push(`checks[${index}].id duplicates check id "${check.id}"`);
        continue;
      }
      ids.add(check.id);
      task.checks.push(check);
    }
  }
  if (Array.isArray(parsed.decisions)) {
    task.decisions = parsed.decisions.filter((value) => typeof value === 'string');
  }
  if (Array.isArray(parsed.followUps)) {
    task.followUps = parsed.followUps.filter((value) => typeof value === 'string');
  }

  validateReportPaths(repoRoot, task, errors, warnings);

  // Declared acceptance coverage: IDs must match, commands may differ only by
  // surrounding whitespace, and cwd may additionally normalize slash separators.
  const expectedCheckIds = manifest?.declared ? manifest.checks.map((check) => check.id) : [];
  const declaredById = new Map((manifest?.declared ? manifest.checks : []).map((check) => [check.id, check]));
  const missingCheckIds = [];
  const additionalCheckIds = [];
  for (const check of task.checks) {
    if (!declaredById.has(check.id)) {
      check.additional = true;
      additionalCheckIds.push(check.id);
    }
  }
  for (const declared of manifest?.declared ? manifest.checks : []) {
    const candidates = task.checks.filter((check) => check.id === declared.id);
    if (candidates.length === 0) {
      missingCheckIds.push(declared.id);
      errors.push(`declared acceptance check "${declared.id}" is missing from the implementer report`);
      continue;
    }
    const reported = candidates[0];
    if (
      normalizeCommand(reported.command) !== normalizeCommand(declared.command) ||
      normalizeCwd(reported.cwd) !== normalizeCwd(declared.cwd)
    ) {
      missingCheckIds.push(declared.id);
      errors.push(
        `declared acceptance check "${declared.id}" does not match the manifest command/cwd ` +
          `(expected ${JSON.stringify(declared.command)} in ${JSON.stringify(declared.cwd)}, ` +
          `reported ${JSON.stringify(reported.command)} in ${JSON.stringify(reported.cwd)})`,
      );
    }
  }

  for (const check of task.checks) {
    const declared = declaredById.get(check.id);
    if (check.status === 'PASS' || check.status === 'FAIL') {
      if (check.logAvailability !== 'PRESENT') {
        const message =
          `check "${check.id}" claims ${check.status} but its log is ${check.logAvailability}` +
          (check.logPath ? ` (${check.logPath})` : ' (logPath null)');
        if (declared) {
          errors.push(message);
        } else {
          warnings.push(message);
          if (result.claimedStatus === 'DONE') {
            errors.push(`DONE report cannot claim evidence completeness: ${message}`);
          }
        }
      }
    }
  }

  if (result.claimedStatus === 'DONE') {
    for (const check of task.checks) {
      if (['FAIL', 'NOT_RUN', 'BLOCKED'].includes(check.status)) {
        errors.push(`DONE status contradicts check "${check.id}" with status ${check.status}`);
      }
      if (
        (check.status === 'PASS' || check.status === 'FAIL') &&
        check.logAvailability !== 'PRESENT'
      ) {
        // Already reported above for declared and extra checks.
      }
    }
  }
  if (result.claimedStatus === 'BLOCKED') {
    const described =
      task.summary.trim().length > 0 || task.followUps.some((value) => value.trim().length > 0);
    if (!described) {
      errors.push('BLOCKED status requires a non-empty summary or followUp describing the blocker');
    }
  }

  result.task = task;
  result.acceptance = {
    expectedCheckIds,
    missingCheckIds,
    additionalCheckIds,
    coverage: manifest?.declared ? (missingCheckIds.length === 0 ? 'COMPLETE' : 'INCOMPLETE') : 'NOT_DECLARED',
  };
  if (errors.length === 0) {
    result.validity = 'VALID';
  } else {
    result.validity = 'INVALID';
    task.status = 'UNKNOWN';
  }
  if (result.claimedStatus === 'DONE') {
    // An invalid DONE must never surface as a trusted status.
    if (result.validity !== 'VALID') task.status = 'UNKNOWN';
    else task.status = 'DONE';
  } else if (result.claimedStatus) {
    task.status = result.validity === 'VALID' ? result.claimedStatus : 'UNKNOWN';
  }
  return result;
}

// --------------------------------------------------------------------------- result assembly

function executionStatusFor(facts) {
  if (facts.timedOut) return 'TIMEOUT';
  if (facts.launchFailed || facts.exitCode === null || facts.exitCode === undefined) {
    return 'LAUNCH_FAILED';
  }
  if (facts.exitCode === 0) return 'SUCCEEDED';
  return 'FAILED';
}

function bridgeExitFor(facts, executionStatus, validity) {
  if (executionStatus === 'TIMEOUT') return 124;
  if (executionStatus === 'LAUNCH_FAILED') return 1;
  if (typeof facts.exitCode === 'number' && facts.exitCode !== 0) return facts.exitCode;
  return validity === 'VALID' ? 0 : 65;
}

function readStderrTail(stderrPath) {
  try {
    return readFileSync(stderrPath, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .slice(-12);
  } catch {
    return [];
  }
}

function readBeforeAfter(facts) {
  const before = readInventory(facts.artifacts.inventoryBefore);
  const after = readInventory(facts.artifacts.inventoryAfter);
  return { before, after };
}

function buildResult(facts) {
  const repoRoot = resolve(facts.repoRoot);
  const startedAt = new Date(facts.startedAt);
  const completedAt = new Date(facts.completedAt);
  const durationMs = roundDuration(completedAt - startedAt);
  const events = parseEventStream(facts.artifacts.events, facts.requestedSession || '');
  const suppliedCaptureErrors = asStringArray(facts.captureErrors);
  const report = parseImplementerReport(events.finalText, {
    repoRoot,
    manifest: facts.manifest,
  });

  if (events.captureErrors.length > 0) {
    report.errors.push(...events.captureErrors);
    report.validity = report.validity === 'MISSING' ? 'MISSING' : 'INVALID';
  }
  if (suppliedCaptureErrors.length > 0) {
    report.errors.push(...suppliedCaptureErrors);
    if (report.validity === 'VALID') report.validity = 'INVALID';
  }
  if (events.malformedLineNumbers.length > 0) {
    report.errors.push(
      `event stream contained ${events.malformedLineNumbers.length} malformed line(s) at line(s) ` +
        `${events.malformedLineNumbers.join(', ')}`,
    );
    if (report.validity === 'VALID') report.validity = 'INVALID';
  }
  if (!events.finalEventPresent) {
    report.validity = 'MISSING';
    if (!report.errors.some((message) => message.includes('final message'))) {
      report.errors.push('no final event was captured from the DSH event stream');
    }
  }
  if (report.validity !== 'VALID') {
    report.task.status = 'UNKNOWN';
  }
  report.errors = [...new Set(report.errors)];
  report.warnings = [...new Set(report.warnings)];

  const executionStatus = executionStatusFor(facts);
  const bridgeExitCode = bridgeExitFor(facts, executionStatus, report.validity);
  const { before, after } = readBeforeAfter(facts);
  const workingTree = compareInventories(before, after);
  if (before.warnings?.length) workingTree.warnings.push(...before.warnings);
  if (after.warnings?.length) workingTree.warnings.push(...after.warnings);
  const inventoryErrors = [
    ...new Set([...asStringArray(facts.inventoryErrors), ...workingTree.warnings]),
  ];
  for (const warning of inventoryErrors) {
    if (!workingTree.warnings.includes(warning)) workingTree.warnings.push(warning);
    if (!report.warnings.includes(warning)) report.warnings.push(warning);
  }
  workingTree.warnings = inventoryErrors;
  const captureErrors = [
    ...new Set([...suppliedCaptureErrors, ...events.captureErrors]),
  ];

  const acceptance = {
    status: 'PENDING',
    coverage: report.acceptance?.coverage ?? (facts.manifest?.declared ? 'INCOMPLETE' : 'NOT_DECLARED'),
    expectedCheckIds: report.acceptance?.expectedCheckIds ?? [],
    missingCheckIds: report.acceptance?.missingCheckIds ?? [],
    additionalCheckIds: report.acceptance?.additionalCheckIds ?? [],
  };
  if (facts.manifest?.declared && acceptance.coverage === 'COMPLETE' && report.validity !== 'VALID') {
    // Coverage can be complete while the report is invalid for another reason; keep the
    // coverage value truthful.
  }

  const finalTextArtifact = artifactPath(repoRoot, facts.artifacts.finalText);
  const resultArtifact = artifactPath(repoRoot, facts.artifacts.result);
  const task = report.task;
  const claimedChanges = task.changes.map((change) => change.path);

  const result = {
    schemaVersion: SCHEMA_VERSION,
    runId: facts.runId,
    sessionId: events.sessionId ?? null,
    sessionProvenance: events.sessionProvenance,
    design: { path: slashPath(facts.designPath) },
    timestamps: {
      startedAt: toIso(startedAt),
      completedAt: toIso(completedAt),
    },
    execution: {
      status: executionStatus,
      originalExitCode: typeof facts.exitCode === 'number' ? facts.exitCode : null,
      bridgeExitCode,
      durationMs,
      settings: {
        mode: facts.settings.mode,
        model: facts.settings.model,
        reasoningEffort: facts.settings.reasoningEffort,
        reasoningEffortSource: facts.settings.reasoningEffortSource,
        codexReviewEdits: facts.settings.codexReviewEdits,
        codexReviewEditsSource: facts.settings.codexReviewEditsSource,
        configuration: facts.settings.configuration,
        preflightObjectLimit: facts.settings.preflightObjectLimit,
        timeoutMinutes: facts.settings.timeoutMinutes,
      },
    },
    task,
    report: {
      validity: report.validity,
      errors: report.errors,
      warnings: report.warnings,
      rawTextArtifact: finalTextArtifact,
      legacyStatus: report.legacyStatus,
    },
    acceptance,
    observations: {
      workingTree,
      toolCalls: events.toolCalls,
      toolErrors: events.toolErrors,
      tokens: events.tokens,
      implementerClaimedChanges: claimedChanges,
    },
    diagnostics: {
      malformedEventLines: {
        count: events.malformedLineNumbers.length,
        lineNumbers: events.malformedLineNumbers,
      },
      lastValidEvent: events.lastValidEvent,
      turnEnd: events.turnEnd,
      error: events.errorText,
      captureErrors,
      inventoryErrors,
      stderrArtifact: artifactPath(repoRoot, facts.artifacts.stderr),
    },
    artifacts: {
      prompt: artifactPath(repoRoot, facts.artifacts.prompt),
      patch: artifactPath(repoRoot, facts.artifacts.patch),
      events: artifactPath(repoRoot, facts.artifacts.events),
      stderr: artifactPath(repoRoot, facts.artifacts.stderr),
      report: artifactPath(repoRoot, facts.artifacts.report),
      result: resultArtifact,
      finalText: finalTextArtifact,
      inventoryBefore: artifactPath(repoRoot, facts.artifacts.inventoryBefore),
      inventoryAfter: artifactPath(repoRoot, facts.artifacts.inventoryAfter),
    },
  };
  return { result, report, events, workingTree, stderrTail: readStderrTail(facts.artifacts.stderr) };
}

// --------------------------------------------------------------------------- Markdown

function yesNo(value) {
  if (value === null || value === undefined) return '(unknown)';
  return value ? 'yes' : 'no';
}

function renderCheckRow(check) {
  const log = check.logPath === null ? '(none)' : `${check.logPath} (${check.logAvailability})`;
  return `| ${markdownCell(check.id)}${check.additional ? ' (additional)' : ''} | ${markdownCell(check.status)} | ${check.exitCode === null ? 'null' : check.exitCode} | ${markdownCell(log)} | ${markdownCell(check.reason)} |`;
}

function renderMarkdown(result, report, events, workingTree, stderrTail, runName) {
  const lines = [];
  const task = result.task;
  const execution = result.execution;
  lines.push(`# dsh implementation run ${runName}`);
  lines.push('');
  lines.push('## Outcome before detail');
  lines.push('');
  lines.push('| dimension | value |');
  lines.push('|---|---|');
  lines.push(`| execution | ${execution.status} (original exit ${execution.originalExitCode ?? 'null'}, bridge exit ${execution.bridgeExitCode}) |`);
  lines.push(`| task (implementer claim) | ${task.status}${task.claimedStatus && task.claimedStatus !== task.status ? ` (claimed ${task.claimedStatus})` : ''} |`);
  lines.push(`| report | ${result.report.validity} |`);
  lines.push(`| acceptance | ${result.acceptance.status} (coverage ${result.acceptance.coverage}) |`);
  lines.push('');
  lines.push('## Artifacts');
  lines.push('');
  lines.push(`- result: \`${result.artifacts.result}\``);
  lines.push(`- prompt: \`${result.artifacts.prompt}\``);
  lines.push(`- patch: \`${result.artifacts.patch}\``);
  lines.push(`- events: \`${result.artifacts.events}\``);
  lines.push(`- stderr: \`${result.artifacts.stderr}\``);
  lines.push(`- final text: \`${result.artifacts.finalText}\``);
  lines.push(`- report: \`${result.artifacts.report}\``);
  lines.push('');
  lines.push('## Execution');
  lines.push('');
  lines.push('| field | value |');
  lines.push('|---|---|');
  lines.push(`| status | ${execution.status} |`);
  lines.push(`| original exit code | ${execution.originalExitCode ?? 'null'} |`);
  lines.push(`| bridge exit code | ${execution.bridgeExitCode} |`);
  lines.push(`| session | ${result.sessionId ?? '(none)'}${result.sessionProvenance ? ` (${result.sessionProvenance})` : ''} |`);
  lines.push(`| design doc | ${result.design.path} |`);
  lines.push(`| permission mode | ${execution.settings.mode} |`);
  lines.push(`| preflight object limit | ${execution.settings.preflightObjectLimit} |`);
  lines.push(`| model | ${execution.settings.model} |`);
  lines.push(`| reasoning effort | ${execution.settings.reasoningEffort} (source: ${execution.settings.reasoningEffortSource}) |`);
  lines.push(`| Codex review edits | ${execution.settings.codexReviewEdits} (source: ${execution.settings.codexReviewEditsSource}) |`);
  lines.push(`| configuration | ${execution.settings.configuration} |`);
  lines.push(`| duration | ${formatDuration(execution.durationMs)} |`);
  lines.push(`| tool calls | ${result.observations.toolCalls} (${result.observations.toolErrors} failed) |`);
  lines.push(`| tokens | ${formatTokens(result.observations.tokens)} |`);
  lines.push(`| turn end | ${events.turnEnd?.reason ?? '(none)'}${events.turnEnd?.error ? ` - ${events.turnEnd.error}` : ''} |`);
  lines.push('');
  lines.push('## Implementer task claim (not acceptance)');
  lines.push('');
  lines.push(`Status: **${task.status}**${task.claimedStatus ? ` (claimed ${task.claimedStatus})` : ''}`);
  lines.push('');
  lines.push(task.summary || '(no summary)');
  lines.push('');
  lines.push('### Claimed changes');
  lines.push('');
  if (task.changes.length === 0) {
    lines.push('(none claimed)');
  } else {
    for (const change of task.changes) {
      lines.push(`- \`${change.path}\` - ${change.description}`);
    }
  }
  lines.push('');
  lines.push('### Claimed checks');
  lines.push('');
  if (task.checks.length === 0) {
    lines.push('(none claimed)');
  } else {
    lines.push('| id | status | exit | log | reason |');
    lines.push('|---|---|---|---|---|');
    for (const check of task.checks) lines.push(renderCheckRow(check));
  }
  lines.push('');
  lines.push('### Decisions');
  lines.push('');
  if (task.decisions.length === 0) lines.push('(none)');
  else for (const decision of task.decisions) lines.push(`- ${decision}`);
  lines.push('');
  lines.push('### Follow-ups');
  lines.push('');
  if (task.followUps.length === 0) lines.push('(none)');
  else for (const followUp of task.followUps) lines.push(`- ${followUp}`);
  lines.push('');
  lines.push('## Report validation');
  lines.push('');
  lines.push(`Validity: **${result.report.validity}**${result.report.legacyStatus ? ' (legacy STATUS prose detected)' : ''}`);
  lines.push('');
  lines.push('### Errors');
  lines.push('');
  if (result.report.errors.length === 0) lines.push('(none)');
  else for (const error of result.report.errors) lines.push(`- ${error}`);
  lines.push('');
  lines.push('### Warnings');
  lines.push('');
  if (result.report.warnings.length === 0) lines.push('(none)');
  else for (const warning of result.report.warnings) lines.push(`- ${warning}`);
  lines.push('');
  lines.push('## Acceptance coverage');
  lines.push('');
  lines.push(`Status: **${result.acceptance.status}** (independent acceptance has not occurred)`);
  lines.push('');
  lines.push(`Coverage: **${result.acceptance.coverage}**`);
  lines.push('');
  lines.push(`Expected check IDs: ${result.acceptance.expectedCheckIds.length ? result.acceptance.expectedCheckIds.join(', ') : '(none declared)'}`);
  lines.push('');
  lines.push(`Missing check IDs: ${result.acceptance.missingCheckIds.length ? result.acceptance.missingCheckIds.join(', ') : '(none)'}`);
  lines.push('');
  lines.push(`Additional check IDs: ${result.acceptance.additionalCheckIds.length ? result.acceptance.additionalCheckIds.join(', ') : '(none)'}`);
  lines.push('');
  lines.push('## Working tree observed during this run');
  lines.push('');
  lines.push('These paths were observed before and after the run. Causality is not asserted; concurrent edits are possible.');
  lines.push('');
  if (workingTree.status === 'UNAVAILABLE') {
    lines.push(`Observation unavailable: ${workingTree.reason ?? 'unknown reason'}`);
  } else {
    lines.push(`HEAD before: ${workingTree.headBefore ?? '(unknown)'}`);
    lines.push('');
    lines.push(`HEAD after: ${workingTree.headAfter ?? '(unknown)'}`);
    lines.push('');
    if (workingTree.paths.length === 0) {
      lines.push('(no changed paths observed)');
    } else {
      for (const entry of workingTree.paths) {
        const before = entry.statusBefore === null ? '(clean)' : entry.statusBefore;
        const after = entry.statusAfter === null ? '(clean)' : entry.statusAfter;
        lines.push(
          `- ${entry.classification}: \`${entry.path}\` [before ${before} / after ${after}; ` +
            `kinds ${entry.changeKinds.join(', ')}]`,
        );
      }
    }
  }
  if (workingTree.warnings.length > 0) {
    lines.push('');
    lines.push('Inventory warnings:');
    for (const warning of workingTree.warnings) lines.push(`- ${warning}`);
  }
  if (result.observations.implementerClaimedChanges.length > 0) {
    lines.push('');
    lines.push('Implementer-claimed changed paths (kept separate from observations):');
    for (const path of result.observations.implementerClaimedChanges) lines.push(`- \`${path}\``);
  }
  lines.push('');
  lines.push('## Diagnostics');
  lines.push('');
  lines.push(`Malformed event lines: ${result.diagnostics.malformedEventLines.count}` +
    (result.diagnostics.malformedEventLines.lineNumbers.length
      ? ` (lines ${result.diagnostics.malformedEventLines.lineNumbers.join(', ')})`
      : ''));
  lines.push('');
  lines.push(
    `Last valid event: ${result.diagnostics.lastValidEvent
      ? `${result.diagnostics.lastValidEvent.type}${result.diagnostics.lastValidEvent.phase ? ` / ${result.diagnostics.lastValidEvent.phase}` : ''}`
      : '(none)'}`,
  );
  lines.push('');
  lines.push(`Turn end: ${result.diagnostics.turnEnd?.reason ?? '(none)'}${result.diagnostics.turnEnd?.error ? ` - ${result.diagnostics.turnEnd.error}` : ''}`);
  lines.push('');
  lines.push(`Error event: ${result.diagnostics.error ?? '(none)'}`);
  lines.push('');
  if (result.diagnostics.captureErrors.length > 0) {
    lines.push('Capture errors:');
    for (const error of result.diagnostics.captureErrors) lines.push(`- ${error}`);
    lines.push('');
  }
  if (result.diagnostics.inventoryErrors.length > 0) {
    lines.push('Inventory errors:');
    for (const error of result.diagnostics.inventoryErrors) lines.push(`- ${error}`);
    lines.push('');
  }
  lines.push('## Raw implementer final message (untrusted)');
  lines.push('');
  lines.push('````text');
  lines.push(report.rawText.trim() || '(empty)');
  lines.push('````');
  lines.push('');
  lines.push('## stderr tail');
  lines.push('');
  lines.push('````text');
  lines.push(stderrTail.length ? stderrTail.join('\n') : '(empty)');
  lines.push('````');
  lines.push('');
  lines.push(`_Report helper schema version ${SCHEMA_VERSION}; helper ${REPORT_HELPER_VERSION}._`);
  return `${lines.join('\n')}\n`;
}

// --------------------------------------------------------------------------- terminal summary

function summaryLines(result) {
  const task = result.task;
  const execution = result.execution;
  const accepted = result.acceptance;
  const workingTree = result.observations.workingTree;
  const counts = workingTree.counts ?? {};
  const changedCount = workingTree.paths?.length ?? 0;
  const lines = [];
  lines.push(
    `config: model ${execution.settings.model} | reasoningEffort ${execution.settings.reasoningEffort} ` +
      `(${execution.settings.reasoningEffortSource}) | codexReviewEdits ${execution.settings.codexReviewEdits} ` +
      `(${execution.settings.codexReviewEditsSource}) | ${execution.settings.configuration}`,
  );
  lines.push(
    `dsh: ${execution.status} | exit ${execution.bridgeExitCode} | ` +
      `${formatDuration(execution.durationMs)} | ${result.observations.toolCalls} tool calls | ` +
      `mode ${execution.settings.mode}`,
  );
  lines.push(
    `execution: ${execution.status} | task: ${task.status} (implementer claim) | ` +
      `report: ${result.report.validity} | acceptance: ${accepted.status}`,
  );
  lines.push(
    `acceptance coverage: ${accepted.coverage} | expected ${accepted.expectedCheckIds.length} | ` +
      `missing ${accepted.missingCheckIds.length} | additional ${accepted.additionalCheckIds.length}`,
  );
  if (result.sessionId) lines.push(`session: ${result.sessionId}`);
  lines.push(`result: ${result.artifacts.result}`);
  lines.push(`report: ${result.artifacts.report}`);
  if (workingTree.status === 'UNAVAILABLE') {
    lines.push(`observed during this run: UNAVAILABLE (${workingTree.reason ?? 'unknown reason'})`);
  } else {
    lines.push(
      `observed during this run: ${changedCount} path(s) | ` +
        `NEWLY_CHANGED ${counts.NEWLY_CHANGED ?? 0} | ` +
        `PREEXISTING_CHANGED ${counts.PREEXISTING_CHANGED ?? 0} | ` +
        `PREEXISTING_UNCHANGED ${counts.PREEXISTING_UNCHANGED ?? 0} | ` +
        `UNKNOWN ${counts.UNKNOWN ?? 0}`,
    );
  }
  lines.push(
    `implementer-claimed changes: ${result.observations.implementerClaimedChanges.length} path(s); ` +
      `tool errors: ${result.observations.toolErrors}; tokens: ${formatTokens(result.observations.tokens)}`,
  );
  if (result.report.errors.length > 0) {
    lines.push(`report diagnostics: ${truncate(result.report.errors[0], 300)}`);
  }
  lines.push(
    `artifacts: prompt ${result.artifacts.prompt} | patch ${result.artifacts.patch} | ` +
      `events ${result.artifacts.events} | stderr ${result.artifacts.stderr} | ` +
      `final ${result.artifacts.finalText} | inventory-before ${result.artifacts.inventoryBefore} | ` +
      `inventory-after ${result.artifacts.inventoryAfter}`,
  );
  return lines;
}

// --------------------------------------------------------------------------- finalize

export function finalizeRun(facts) {
  const repoRoot = resolve(facts.repoRoot);
  const { result, report, events, workingTree, stderrTail } = buildResult(facts);
  const resultFile = resolve(facts.artifacts.result);
  atomicWrite(facts.artifacts.finalText, report.rawText);
  writeJsonAtomic(resultFile, result);
  const markdown = renderMarkdown(result, report, events, workingTree, stderrTail, facts.runId);
  atomicWrite(facts.artifacts.report, markdown);
  return {
    ok: true,
    bridgeExitCode: result.execution.bridgeExitCode,
    resultFile,
    resultRelative: artifactPath(repoRoot, resultFile),
    reportRelative: result.artifacts.report,
    finalTextFile: resolve(facts.artifacts.finalText),
    summaryLines: summaryLines(result),
    result,
  };
}

// --------------------------------------------------------------------------- MCP result reading

export function validateResultRecord(value) {
  if (!isPlainObject(value)) return 'result must be a JSON object';
  if (value.schemaVersion !== SCHEMA_VERSION) return 'result schemaVersion must be numeric 1';
  if (typeof value.runId !== 'string' || !RUN_ID_PATTERN.test(value.runId)) return 'result runId is not valid';
  if (!(value.sessionId === null || typeof value.sessionId === 'string')) {
    return 'result sessionId must be a string or null';
  }
  if (!isPlainObject(value.execution)) return 'result execution is missing';
  if (!EXECUTION_STATUSES.includes(value.execution.status)) return 'result execution.status is not recognized';
  if (!Number.isInteger(value.execution.bridgeExitCode)) return 'result execution.bridgeExitCode must be an integer';
  if (!(value.execution.originalExitCode === null || Number.isInteger(value.execution.originalExitCode))) {
    return 'result execution.originalExitCode must be an integer or null';
  }
  if (!isPlainObject(value.task)) return 'result task is missing';
  if (!TASK_STATUSES.includes(value.task.status)) return 'result task.status is not recognized';
  if (!isPlainObject(value.report)) return 'result report is missing';
  if (!REPORT_VALIDITY.includes(value.report.validity)) return 'result report.validity is not recognized';
  if (!Array.isArray(value.report.errors) || !Array.isArray(value.report.warnings)) {
    return 'result report errors/warnings must be arrays';
  }
  if (!isPlainObject(value.acceptance) || value.acceptance.status !== 'PENDING') {
    return 'result acceptance must be PENDING';
  }
  if (!COVERAGE.includes(value.acceptance.coverage)) return 'result acceptance.coverage is not recognized';
  if (!isPlainObject(value.observations)) return 'result observations is missing';
  if (!isPlainObject(value.observations.workingTree)) return 'result observations.workingTree is missing';
  if (!isPlainObject(value.diagnostics)) return 'result diagnostics is missing';
  if (!isPlainObject(value.artifacts)) return 'result artifacts is missing';
  if (typeof value.artifacts.result !== 'string') return 'result artifacts.result must be a string';
  return null;
}

export function readResultArtifact(repoRootInput, relativePath) {
  const repoRoot = resolve(repoRootInput);
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    return { error: 'result path is empty' };
  }
  const normalized = slashPath(relativePath);
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.includes('\0')) {
    return { error: `result path must be repository-relative: ${relativePath}` };
  }
  const parts = normalized.split('/');
  if (!parts.includes('.dsh-runs') || parts.some((part) => part === '..' || part === '')) {
    return { error: `result path is outside the expected .dsh-runs artifact location: ${relativePath}` };
  }
  if (parts[0] !== '.dsh-runs' || parts.length !== 2) {
    return { error: `result path is not a direct .dsh-runs artifact: ${relativePath}` };
  }
  const match = RESULT_NAME_PATTERN.exec(parts[1]);
  if (!match) {
    return { error: `result file name is not a bridge result artifact: ${relativePath}` };
  }
  let stat;
  try {
    stat = statSync(repoRoot);
  } catch {
    return { error: `repository root is not readable: ${repoRoot}` };
  }
  if (!stat.isDirectory()) return { error: `repository root is not a directory: ${repoRoot}` };

  // Inspect every component without following links/reparse points. Node reports Windows
  // junctions as directories, so compare each resolved component with its logical path.
  let realRoot;
  try {
    realRoot = realpathSync.native(repoRoot);
  } catch (error) {
    return { error: `repository root is not readable: ${error.code ?? error.message}` };
  }
  let current = repoRoot;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const expected = join(realRoot, ...parts.slice(0, index + 1));
    let lstat;
    try {
      lstat = lstatSync(current);
    } catch (error) {
      return { error: `result artifact is not readable: ${error.code ?? error.message}` };
    }
    if (lstat.isSymbolicLink()) {
      return { error: 'result artifact path contains a symlink or reparse point' };
    }
    if (index < parts.length - 1 && !lstat.isDirectory()) {
      return { error: 'result artifact path contains a non-directory component' };
    }
    if (index === parts.length - 1 && !lstat.isFile()) {
      return { error: 'result artifact is not a regular file' };
    }
    let realCurrent;
    try {
      realCurrent = realpathSync.native(current);
    } catch (error) {
      return { error: `result artifact is not readable: ${error.code ?? error.message}` };
    }
    if (!sameCanonicalPath(realCurrent, expected)) {
      return { error: 'result artifact path contains a symlink or reparse point' };
    }
  }
  let expectedReal;
  const absolute = join(current);
  try {
    const realRoot = realpathSync.native(repoRoot);
    expectedReal = realpathSync.native(absolute);
    const rel = relative(realRoot, expectedReal);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return { error: 'result artifact escapes the repository' };
    }
  } catch (error) {
    return { error: `result artifact is not readable: ${error.code ?? error.message}` };
  }
  let raw;
  let fd;
  try {
    fd = openSync(absolute, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      return { error: 'result artifact is not a regular file' };
    }
    const afterOpenReal = realpathSync.native(absolute);
    if (afterOpenReal !== expectedReal) {
      return { error: 'result artifact changed identity while being read' };
    }
    raw = readFileSync(fd, 'utf8');
  } catch (error) {
    return { error: `result artifact is not readable: ${error.code ?? error.message}` };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { error: `result artifact is not valid JSON: ${error.message}` };
  }
  const invalid = validateResultRecord(parsed);
  if (invalid) return { error: invalid };
  if (parsed.runId !== match[1]) {
    return { error: 'result runId does not match its artifact file name' };
  }
  return { result: parsed, absolute, relativePath: slashPath(relative(repoRoot, absolute)) };
}

// --------------------------------------------------------------------------- CLI

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`missing value for --${key}`);
    options[key] = value;
    index += 1;
  }
  return options;
}

function commandManifest(options) {
  if (!options.design) throw new Error('--design is required');
  const design = readFileSync(options.design, 'utf8');
  const manifest = parseAcceptanceManifest(design);
  process.stdout.write(`${JSON.stringify(manifest)}\n`);
}

function commandInventory(options) {
  if (!options.root) throw new Error('--root is required');
  if (!options.out) throw new Error('--out is required');
  const root = resolve(options.root);
  const inventory = takeInventory(root);
  inventory.rootForInventory = root;
  let include = null;
  if (options.include) include = readInventory(options.include);
  if (include && include.status === 'OBSERVED') {
    addAdditionalCleanPaths(inventory, include);
    inventory.paths = inventory.paths.filter((entry) => entry.path !== undefined);
    inventory.paths.sort((left, right) => left.path.localeCompare(right.path));
  }
  const { rootForInventory, ...serializable } = inventory;
  writeJsonAtomic(resolve(options.out), serializable);
}

function commandFinalize(options) {
  if (!options.input) throw new Error('--input is required');
  const facts = JSON.parse(readFileSync(options.input, 'utf8'));
  if (!isPlainObject(facts) || facts.schemaVersion !== 1) {
    throw new Error('facts file has an unsupported schemaVersion');
  }
  const outcome = finalizeRun(facts);
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = parseArguments(rest);
  switch (command) {
    case 'manifest':
      commandManifest(options);
      return;
    case 'inventory':
      commandInventory(options);
      return;
    case 'finalize':
      commandFinalize(options);
      return;
    default:
      throw new Error(`unknown command: ${command ?? '(none)'}`);
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
const modulePath = resolve(fileURLToPath(import.meta.url));
if (invokedPath && invokedPath === modulePath) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
}
