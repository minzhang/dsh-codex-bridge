import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { after, before, describe } from 'node:test';

import { captureProcess, CaptureTimeoutError } from '../../dsh-codex-bridge/node/capture-process.mjs';

const originalTemporaryDirectory = tmpdir();
const temporaryEnvironmentNames = ['TMPDIR', 'TMP', 'TEMP'];
const originalTemporaryEnvironment = new Map();
let suiteTemporaryDirectory;
let suiteEnvironmentScoped = false;

function captureDirectories() {
  return new Set(readdirSync(suiteTemporaryDirectory).filter((name) => name.startsWith('dsh-capture-')));
}

function newCaptureDirectories(before) {
  return [...captureDirectories()].filter((name) => !before.has(name));
}

function restoreTemporaryEnvironment() {
  for (const name of temporaryEnvironmentNames) {
    const originalValue = originalTemporaryEnvironment.get(name);
    if (originalValue === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = originalValue;
    }
  }
  originalTemporaryEnvironment.clear();
}

function removeSuiteTemporaryDirectory() {
  if (suiteTemporaryDirectory) {
    rmSync(suiteTemporaryDirectory, { recursive: true, force: true });
    suiteTemporaryDirectory = undefined;
  }
}

describe('file-backed capture helper', () => {
  before(() => {
    suiteTemporaryDirectory = mkdtempSync(join(originalTemporaryDirectory, 'dsh-capture-scope-'));
    try {
      for (const name of temporaryEnvironmentNames) {
        originalTemporaryEnvironment.set(name, process.env[name]);
        process.env[name] = suiteTemporaryDirectory;
      }
      const effectiveTemporaryDirectory = resolve(tmpdir());
      if (effectiveTemporaryDirectory.toLowerCase() !== resolve(suiteTemporaryDirectory).toLowerCase()) {
        throw new Error(
          `Could not scope the capture helper temporary directory: ${effectiveTemporaryDirectory}`,
        );
      }
      suiteEnvironmentScoped = true;
      assert.deepEqual([...captureDirectories()], []);
    } catch (error) {
      suiteEnvironmentScoped = false;
      restoreTemporaryEnvironment();
      removeSuiteTemporaryDirectory();
      throw error;
    }
  });

  after(() => {
    try {
      if (suiteEnvironmentScoped) {
        const expectedEnvironment = new Map(originalTemporaryEnvironment);
        restoreTemporaryEnvironment();
        for (const name of temporaryEnvironmentNames) {
          assert.equal(process.env[name], expectedEnvironment.get(name));
        }
        suiteEnvironmentScoped = false;
      }
    } finally {
      removeSuiteTemporaryDirectory();
    }
  });

  test('captures file-backed stdout, stderr, and exit code', { concurrency: false }, async () => {
    const before = captureDirectories();
    const result = await captureProcess(process.execPath, [
      '-e',
      "process.stdout.write('stdout-value'); process.stderr.write('stderr-value'); process.exit(7);",
    ]);
    assert.equal(result.code, 7);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, 'stdout-value');
    assert.equal(result.stderr, 'stderr-value');
    assert.deepEqual(newCaptureDirectories(before), []);
  });

  test('preserves argument boundaries without shell interpretation', { concurrency: false }, async () => {
    const before = captureDirectories();
    const args = ['a b', '"quoted"', '', 'semi;colon'];
    const result = await captureProcess(process.execPath, [
      '-e',
      'console.log(JSON.stringify(process.argv.slice(1)));',
      ...args,
    ]);
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout.trim()), args);
    assert.deepEqual(newCaptureDirectories(before), []);
  });

  test('honors cwd and a replacement environment and ignores stdin', { concurrency: false }, async () => {
    const before = captureDirectories();
    const cwd = tmpdir();
    const result = await captureProcess(
      process.execPath,
      [
        '-e',
        "const fs=require('node:fs'); const stdin=fs.readFileSync(0,'utf8'); console.log(JSON.stringify({cwd:process.cwd(),value:process.env.CAPTURE_TEST_VALUE,stdin}));",
      ],
      {
        cwd,
        env: { ...process.env, CAPTURE_TEST_VALUE: 'present' },
      },
    );
    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.cwd.toLowerCase(), cwd.toLowerCase());
    assert.equal(parsed.value, 'present');
    assert.equal(parsed.stdin, '');
    assert.deepEqual(newCaptureDirectories(before), []);
  });

  test('captures large output without a pipe buffer limit', { concurrency: false }, async () => {
    const before = captureDirectories();
    const result = await captureProcess(process.execPath, [
      '-e',
      "process.stdout.write('x'.repeat(256 * 1024));",
    ]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout.length, 256 * 1024);
    assert.deepEqual(newCaptureDirectories(before), []);
  });

  test('reports spawn failure and removes its temporary directory', { concurrency: false }, async () => {
    const before = captureDirectories();
    const missing = join(tmpdir(), `definitely-missing-${Date.now()}-${Math.random().toString(16).slice(2)}.exe`);
    await assert.rejects(
      captureProcess(missing, []),
      (error) => {
        assert.equal(error.name, 'CaptureProcessError');
        assert.equal(error.code, 'ENOENT');
        return true;
      },
    );
    assert.deepEqual(newCaptureDirectories(before), []);
  });

  test('times out, terminates the child, and removes its temporary directory', { timeout: 20_000, concurrency: false }, async () => {
    const before = captureDirectories();
    await assert.rejects(
      captureProcess(process.execPath, ['-e', 'setTimeout(() => {}, 60_000);'], { timeoutMs: 300 }),
      (error) => {
        assert.ok(error instanceof CaptureTimeoutError);
        assert.equal(error.timedOut, true);
        assert.equal(error.timeoutMs, 300);
        return true;
      },
    );
    assert.deepEqual(newCaptureDirectories(before), []);
  });
});
