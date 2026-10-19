import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import test from 'node:test';

import {
  inspectDelivery,
  loadDeliveryFiles,
  packageDelivery,
  REPOSITORY_ROOT,
} from '../scripts/package.mjs';

const expectedDeliveryFiles = [
  '.gitignore',
  'AGENTS.md',
  'LICENSE',
  'README.md',
  'docs/design/TEMPLATE.md',
  'docs/node-testing.md',
  'docs/windows-sandbox.md',
  'dsh-impl.ps1',
  'mcp/dsh-mcp-server.mjs',
  'node/capture-process.d.mts',
  'node/capture-process.mjs',
  'node/run-tests.mjs',
  'windows/lib/dsh-acl.mjs',
  'windows/lib/interop.ps1',
  'windows/lib/setup-lib.ps1',
  'windows/lib/verify-node.mjs',
  'windows/lib/verify-run.ps1',
  'windows/setup.ps1',
];

const testStateRoot = resolve(import.meta.dirname, '..', '.state', 'package-tests');

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function ensureDirectory(path) {
  mkdirSync(path, { recursive: true });
}

function writeFixtureFile(path, content) {
  ensureDirectory(dirname(path));
  writeFileSync(path, content, 'utf8');
}

function walkFiles(root) {
  const files = [];
  function visit(directory, relativeDirectory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath, relativePath);
      } else {
        files.push(relativePath);
      }
    }
  }
  visit(root, '');
  return files.sort();
}

function createFixture() {
  ensureDirectory(testStateRoot);
  const directory = mkdtempSync(join(testStateRoot, 'fixture-'));
  const kit = join(directory, 'dsh-codex-bridge');
  const allowlist = loadDeliveryFiles(REPOSITORY_ROOT);

  for (const entry of allowlist) {
    const source = join(REPOSITORY_ROOT, 'dsh-codex-bridge', ...entry.split('/'));
    const destination = join(kit, ...entry.split('/'));
    ensureDirectory(dirname(destination));
    copyFileSync(source, destination);
  }

  writeFixtureFile(join(kit, '.state', 'sentinel.txt'), 'local-state-must-not-export');
  writeFixtureFile(
    join(directory, 'development', 'delivery-files.json'),
    readFileSync(join(REPOSITORY_ROOT, 'development', 'delivery-files.json'), 'utf8'),
  );
  return { directory, kit };
}

function writeExistingOutput(directory) {
  writeFixtureFile(join(directory, '.artifacts', 'dsh-codex-bridge', 'keep.txt'), 'keep-export\n');
  writeFixtureFile(join(directory, '.artifacts', 'SHA256SUMS.txt'), 'old-checksums\n');
}

function readExistingOutput(directory) {
  return {
    export: readFileSync(join(directory, '.artifacts', 'dsh-codex-bridge', 'keep.txt'), 'utf8'),
    checksums: readFileSync(join(directory, '.artifacts', 'SHA256SUMS.txt'), 'utf8'),
  };
}

function assertExistingOutputUnchanged(directory, before) {
  const after = readExistingOutput(directory);
  assert.equal(after.export, before.export);
  assert.equal(after.checksums, before.checksums);
}

function cleanupFixture(directory) {
  const base = resolve(testStateRoot);
  const target = resolve(directory);
  if (target === base || !target.startsWith(`${base}${sep}`)) {
    throw new Error(`Refusing cleanup outside the packaging test state directory: ${target}`);
  }
  rmSync(target, { recursive: true, force: true });
}

function makeDirectoryLink(target, linkPath) {
  if (process.platform === 'win32') {
    symlinkSync(target, linkPath, 'junction');
  } else {
    symlinkSync(target, linkPath, 'dir');
  }
}

function removeDirectoryLink(linkPath) {
  try {
    rmdirSync(linkPath);
  } catch {
    rmSync(linkPath, { force: true });
  }
}

test('packaging: allowlist is explicit and the real delivery source matches it exactly', () => {
  const allowlist = loadDeliveryFiles(REPOSITORY_ROOT);
  assert.deepEqual([...allowlist], expectedDeliveryFiles);
  assert.deepEqual(inspectDelivery().files, expectedDeliveryFiles);

  for (const required of [
    'LICENSE',
    'README.md',
    'AGENTS.md',
    '.gitignore',
    'dsh-impl.ps1',
    'docs/windows-sandbox.md',
    'docs/node-testing.md',
    'docs/design/TEMPLATE.md',
    'windows/lib/verify-node.mjs',
  ]) {
    assert.ok(allowlist.includes(required), `allowlist must include ${required}`);
  }
  assert.equal(allowlist.includes('docs/design/VERIFY-NEW-REPO.md'), false);
  assert.equal(allowlist.some((entry) => entry.startsWith('tests/')), false);
  assert.equal(allowlist.some((entry) => entry === '.state' || entry.startsWith('.state/')), false);
});

test('packaging: export contains exactly the allowlisted bytes, checksums, license, and probe', () => {
  const fixture = createFixture();
  try {
    const result = packageDelivery({ repoRoot: fixture.directory });
    const exportedRoot = join(fixture.directory, '.artifacts', 'dsh-codex-bridge');
    const exported = walkFiles(exportedRoot);

    assert.deepEqual(exported, expectedDeliveryFiles);
    assert.ok(exported.includes('LICENSE'));
    assert.ok(exported.includes('windows/lib/verify-node.mjs'));
    assert.equal(exported.some((entry) => entry === '.state' || entry.startsWith('.state/')), false);
    assert.equal(exported.some((entry) => entry.startsWith('tests/')), false);
    assert.equal(existsSync(join(exportedRoot, '.state')), false);

    assert.equal(lstatSync(result.checksumsPath).isFile(), true);
    const checksums = readFileSync(result.checksumsPath, 'utf8');
    assert.match(checksums, /\n$/);
    const lines = checksums.trimEnd().split(/\r?\n/);
    assert.equal(lines.length, expectedDeliveryFiles.length);

    const observed = new Map();
    for (const line of lines) {
      const match = /^([a-f0-9]{64})  dsh-codex-bridge\/(.+)$/.exec(line);
      assert.ok(match, `checksum line must be well formed: ${line}`);
      const [, digest, relativePath] = match;
      assert.equal(observed.has(relativePath), false, `duplicate checksum path: ${relativePath}`);
      observed.set(relativePath, digest);
      assert.equal(digest, sha256(join(fixture.kit, ...relativePath.split('/'))));
    }
    assert.deepEqual([...observed.keys()].sort(), expectedDeliveryFiles);
  } finally {
    cleanupFixture(fixture.directory);
  }
});

test('packaging: a missing allowlisted file is rejected without touching output', () => {
  const fixture = createFixture();
  try {
    writeExistingOutput(fixture.directory);
    const before = readExistingOutput(fixture.directory);
    rmSync(join(fixture.kit, 'docs', 'node-testing.md'));

    assert.throws(
      () => packageDelivery({ repoRoot: fixture.directory }),
      /missing allowlisted file/,
    );
    assertExistingOutputUnchanged(fixture.directory, before);
  } finally {
    cleanupFixture(fixture.directory);
  }
});

test('packaging: maintainer tests and other unexpected source files are rejected without touching output', () => {
  const fixture = createFixture();
  try {
    writeExistingOutput(fixture.directory);
    const before = readExistingOutput(fixture.directory);
    writeFixtureFile(join(fixture.kit, 'tests', 'leak.test.mjs'), "import test from 'node:test';\n");
    writeFixtureFile(join(fixture.kit, 'docs', 'design', 'VERIFY-NEW-REPO.md'), '# moved out\n');

    assert.throws(
      () => packageDelivery({ repoRoot: fixture.directory }),
      /unexpected file/,
    );
    assertExistingOutputUnchanged(fixture.directory, before);
  } finally {
    cleanupFixture(fixture.directory);
  }
});

test('packaging: a source symlink or junction is rejected without touching output', () => {
  const fixture = createFixture();
  const linkTarget = join(fixture.directory, 'link-target');
  const linkPath = join(fixture.kit, 'docs', 'node-testing.md');
  let linked = false;
  try {
    writeExistingOutput(fixture.directory);
    const before = readExistingOutput(fixture.directory);
    writeFixtureFile(join(linkTarget, 'target.txt'), 'link-target\n');
    rmSync(linkPath);
    makeDirectoryLink(linkTarget, linkPath);
    linked = true;

    assert.throws(
      () => packageDelivery({ repoRoot: fixture.directory }),
      /symlink|reparse/i,
    );
    assertExistingOutputUnchanged(fixture.directory, before);
  } finally {
    if (linked) removeDirectoryLink(linkPath);
    cleanupFixture(fixture.directory);
  }
});

test('packaging: output redirected outside .artifacts is rejected without writing there', () => {
  const fixture = createFixture();
  const outside = join(fixture.directory, 'outside-artifacts');
  const artifactsLink = join(fixture.directory, '.artifacts');
  let linked = false;
  try {
    ensureDirectory(outside);
    makeDirectoryLink(outside, artifactsLink);
    linked = true;

    assert.throws(
      () => packageDelivery({ repoRoot: fixture.directory }),
      /artifacts output|symlink|reparse/i,
    );
    assert.deepEqual(readdirSync(outside), []);
  } finally {
    if (linked) removeDirectoryLink(artifactsLink);
    cleanupFixture(fixture.directory);
  }
});

test('packaging: an existing export is refused without overwriting it', () => {
  const fixture = createFixture();
  try {
    writeExistingOutput(fixture.directory);
    const before = readExistingOutput(fixture.directory);

    assert.throws(
      () => packageDelivery({ repoRoot: fixture.directory }),
      /Refusing to overwrite existing (export|checksums)/,
    );
    assertExistingOutputUnchanged(fixture.directory, before);
  } finally {
    cleanupFixture(fixture.directory);
  }
});
