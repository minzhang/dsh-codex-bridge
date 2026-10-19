#!/usr/bin/env node
// Run an explicit list of Node test files with test isolation disabled.
// This is the helper a sandboxed project uses after its normal build step; it
// deliberately contains no project-specific test list and no build assumptions.

import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const MINIMUM_NODE = [22, 14, 0];

function fail(message, exitCode = 1) {
  process.stderr.write(`${message}\n`);
  process.exitCode = exitCode;
}

function assertSupportedNode() {
  const parts = process.versions.node.split('.').map((value) => Number.parseInt(value, 10));
  for (let index = 0; index < MINIMUM_NODE.length; index += 1) {
    if (parts[index] > MINIMUM_NODE[index]) return;
    if (parts[index] < MINIMUM_NODE[index]) {
      throw new Error(
        `Node ${MINIMUM_NODE.join('.')} or newer is required; this is ${process.versions.node}`,
      );
    }
  }
}

function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    fail('usage: node node/run-tests.mjs <test-file> [test-file ...]', 2);
    return;
  }
  for (const file of files) {
    if (!existsSync(file) || !statSync(file).isFile()) {
      fail(`test file not found (or not a file): ${file}`, 2);
      return;
    }
  }
  try {
    assertSupportedNode();
  } catch (error) {
    fail(error.message, 2);
    return;
  }

  // Absolute paths keep a file whose name begins with "-" from being parsed as
  // a Node option, and preserve spaces/argument boundaries without a shell.
  const resolvedFiles = files.map((file) => resolve(file));
  const child = spawn(
    process.execPath,
    ['--test', '--experimental-test-isolation=none', ...resolvedFiles],
    {
      stdio: 'inherit',
      windowsHide: true,
      shell: false,
    },
  );

  let settled = false;
  const finish = (code, signal) => {
    if (settled) return;
    settled = true;
    if (signal) {
      process.stderr.write(`test process terminated by ${signal}\n`);
      try {
        process.kill(process.pid, signal);
      } catch {
        process.exitCode = 1;
      }
      return;
    }
    process.exitCode = code ?? 1;
  };

  child.once('error', (error) => {
    if (settled) return;
    settled = true;
    process.stderr.write(`failed to start test runner: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.once('close', finish);
}

main();
