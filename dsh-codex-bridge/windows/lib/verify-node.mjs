// Runs inside the installed DSH workspace-write runner with Node test worker
// isolation disabled. It exercises the package capture helper with a real Node
// child and proves the child can write its private temp but not the ambient
// outside-workspace sentinel.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { captureProcess } from '../../node/capture-process.mjs';

const sentinel = process.env.DSH_VERIFY_SENTINEL;

test('file-backed capture returns stdout, stderr, and the real exit code', async () => {
  const result = await captureProcess(process.execPath, [
    '-e',
    "process.stdout.write('capture-out'); process.stderr.write('capture-err'); process.exit(3);",
  ]);
  assert.equal(result.code, 3);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, 'capture-out');
  assert.equal(result.stderr, 'capture-err');
});

test('real Node child writes private temp and is denied outside the workspace', async () => {
  assert.ok(sentinel, 'DSH_VERIFY_SENTINEL must be set by verify-run.ps1');
  const before = readFileSync(sentinel, 'utf8');
  const temp = mkdtempSync(join(tmpdir(), 'dsh-confined-child-'));
  const inside = join(temp, 'inside.txt');
  const child = [
    "const fs = require('node:fs');",
    "fs.writeFileSync(process.env.DSH_VERIFY_INSIDE, 'inside-ok');",
    'let denied = false;',
    'let detail = "";',
    'try { fs.appendFileSync(process.env.DSH_VERIFY_SENTINEL, "UNEXPECTED"); }',
    'catch (error) { denied = error.code === "EPERM" || error.code === "EACCES"; detail = error.code || error.message; }',
    'console.log("child-out:" + denied);',
    'console.error("child-err:" + detail);',
    'process.exit(denied ? 5 : 6);',
  ].join('\n');

  try {
    const result = await captureProcess(process.execPath, ['-e', child], {
      cwd: temp,
      env: { ...process.env, DSH_VERIFY_INSIDE: inside },
      timeoutMs: 20_000,
    });
    assert.equal(result.code, 5);
    assert.match(result.stdout, /child-out:true/);
    assert.match(result.stderr, /child-err:(EPERM|EACCES)/);
    assert.equal(readFileSync(inside, 'utf8'), 'inside-ok');
    assert.equal(readFileSync(sentinel, 'utf8'), before);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('outside sentinel remains readable and unchanged', () => {
  assert.ok(sentinel, 'DSH_VERIFY_SENTINEL must be set by verify-run.ps1');
  const content = readFileSync(sentinel, 'utf8');
  assert.match(content, /^dsh-outside-sentinel-/);
});
