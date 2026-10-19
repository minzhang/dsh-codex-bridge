import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { captureProcess } from '../../dsh-codex-bridge/node/capture-process.mjs';

const helper = join(import.meta.dirname, '..', '..', 'dsh-codex-bridge', 'node', 'run-tests.mjs');
const childEnv = { ...process.env };
delete childEnv.NODE_TEST_CONTEXT;

function makeFixture() {
  return mkdtempSync(join(tmpdir(), 'dsh-run-tests-'));
}

function writeTestFile(directory, name, body) {
  const path = join(directory, name);
  writeFileSync(path, body, 'utf8');
  return path;
}

test('empty test list fails clearly without running tests', { timeout: 20_000, concurrency: false }, async () => {
  const result = await captureProcess(process.execPath, [helper], { env: childEnv });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /usage: node node\/run-tests\.mjs/);
  assert.equal(result.stdout, '');
});

test('forwards explicit test files, inherits stdio, and exits zero', { timeout: 30_000, concurrency: false }, async () => {
  const directory = makeFixture();
  try {
    const markerOne = join(directory, 'one.marker');
    const markerTwo = join(directory, 'two.marker');
    const one = writeTestFile(
      directory,
      'one.test.mjs',
      `import { writeFileSync } from 'node:fs';\nimport test from 'node:test';\ntest('one', () => writeFileSync(${JSON.stringify(markerOne)}, 'one'));\n`,
    );
    const two = writeTestFile(
      directory,
      'two.test.mjs',
      `import { writeFileSync } from 'node:fs';\nimport test from 'node:test';\ntest('two', () => writeFileSync(${JSON.stringify(markerTwo)}, 'two'));\n`,
    );
    const result = await captureProcess(process.execPath, [helper, one, two], { env: childEnv });
    assert.equal(result.code, 0);
    assert.equal(readFileSync(markerOne, 'utf8'), 'one');
    assert.equal(readFileSync(markerTwo, 'utf8'), 'two');
    assert.match(result.stdout, /# tests 2/);
    assert.match(result.stdout, /# pass 2/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('forwards a failing test exit code', { timeout: 30_000, concurrency: false }, async () => {
  const directory = makeFixture();
  try {
    const failing = writeTestFile(
      directory,
      'failing.test.mjs',
      "import assert from 'node:assert/strict';\nimport test from 'node:test';\ntest('failing', () => assert.fail('expected failure'));\n",
    );
    const result = await captureProcess(process.execPath, [helper, failing], { env: childEnv });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /# fail 1/);
    assert.match(result.stdout, /expected failure/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects test arguments that are missing', { timeout: 20_000, concurrency: false }, async () => {
  const directory = makeFixture();
  try {
    const missing = join(directory, 'missing.test.mjs');
    const result = await captureProcess(process.execPath, [helper, missing], { env: childEnv });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /test file not found/);
    assert.equal(existsSync(missing), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
