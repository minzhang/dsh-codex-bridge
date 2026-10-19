import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { captureProcess } from '../../dsh-codex-bridge/node/capture-process.mjs';

const runner = fileURLToPath(new URL('../../dsh-codex-bridge/node/run-tests.mjs', import.meta.url));
const childEnv = { ...process.env };
delete childEnv.NODE_TEST_CONTEXT;

test('reviewer: a test filename resembling a Node option is executed as a file', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bridge reviewer '));
  try {
    const filename = '--test-name-pattern=never.test.mjs';
    writeFileSync(join(directory, filename),
      "import test from 'node:test'; test('actual explicit file', () => {});\n");
    const result = await captureProcess(process.execPath, [runner, filename], {
      cwd: directory, env: childEnv, timeoutMs: 10000,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /# tests 1\b/);
    assert.match(result.stdout, /# pass 1\b/);
    assert.match(result.stdout, /# skipped 0\b/);
  } finally {
    // Only the exact fresh directory created above is removed.
    rmSync(directory, { recursive: true, force: true });
  }
});

test('reviewer: capture preserves literal arguments and cwd with spaces', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bridge reviewer '));
  try {
    const args = ['space value', '$(literal)', '&literal', 'a"b'];
    const result = await captureProcess(process.execPath,
      ['-e', 'console.log(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd()}))', ...args],
      { cwd: directory, env: childEnv, timeoutMs: 10000 });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { args, cwd: directory });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
