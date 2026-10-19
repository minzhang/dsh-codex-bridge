import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createEditor, reduceEditor } from '../src/editor.js';
import { main, runTerminal } from '../src/cli.js';

const CLI_PATH = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RUNS = join(ROOT, '.dsh-runs');
const CLI_TIMEOUT_MS = 10_000;
const NPM_TIMEOUT_MS = 60_000;

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface CapturedCommand {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  label: string;
}

function temporaryDirectory(prefix: string): string {
  mkdirSync(RUNS, { recursive: true });
  return mkdtempSync(join(RUNS, prefix));
}

function runCaptured(options: CapturedCommand): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    // The sandbox blocks named-pipe stdio capture for descendants, so the
    // child writes to real files in a helper-owned repository-local directory.
    const tempDir = temporaryDirectory('test-cli-');
    const stdoutPath = join(tempDir, 'stdout.txt');
    const stderrPath = join(tempDir, 'stderr.txt');
    let stdoutFd: number | undefined;
    let stderrFd: number | undefined;
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    let timedOut = false;

    const cleanup = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      for (const fd of [stdoutFd, stderrFd]) {
        if (fd !== undefined) {
          try {
            closeSync(fd);
          } catch {
            // Best effort: the descriptor may already be closed.
          }
        }
      }
      stdoutFd = undefined;
      stderrFd = undefined;
      try {
        rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        // Best effort: only this helper's own directory is removed.
      }
    };

    const fail = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    let child: ChildProcess;
    try {
      stdoutFd = openSync(stdoutPath, 'w');
      stderrFd = openSync(stderrPath, 'w');

      const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
      delete env.NODE_TEST_CONTEXT;

      child = spawn(options.command, options.args, {
        cwd: ROOT,
        stdio: ['ignore', stdoutFd, stderrFd],
        windowsHide: true,
        env,
      });
    } catch (error) {
      fail(error);
      return;
    }

    // The child owns the inherited handles; the parent copies can close now.
    for (const fd of [stdoutFd, stderrFd]) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // Ignored; cleanup still clears the remaining handles.
        }
      }
    }
    stdoutFd = undefined;
    stderrFd = undefined;

    timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      if (!settled) {
        const command = [options.command, ...options.args].join(' ');
        settled = true;
        cleanup();
        reject(
          new Error(
            `${options.label} did not exit within ${options.timeoutMs}ms: ${command}`,
          ),
        );
      }
    }, options.timeoutMs);

    child.once('error', (error) => {
      fail(error);
    });

    child.once('close', (code, signal) => {
      if (timedOut) {
        // Retry cleanup in case the killed child still held the output files.
        cleanup();
        return;
      }
      if (settled) {
        return;
      }

      let stdout: string;
      let stderr: string;
      try {
        stdout = readFileSync(stdoutPath, 'utf8');
        stderr = readFileSync(stderrPath, 'utf8');
      } catch (error) {
        fail(error);
        return;
      }

      settled = true;
      cleanup();
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function runCli(args: string[]): Promise<RunResult> {
  return runCaptured({
    command: process.execPath,
    args: [CLI_PATH, ...args],
    timeoutMs: CLI_TIMEOUT_MS,
    label: 'CLI subprocess',
  });
}

function npmCliPath(): string {
  const fromEnvironment = process.env.npm_execpath;
  if (
    fromEnvironment !== undefined &&
    fromEnvironment.endsWith('.js') &&
    existsSync(fromEnvironment)
  ) {
    return fromEnvironment;
  }

  const candidate = join(
    dirname(process.execPath),
    'node_modules',
    'npm',
    'bin',
    'npm-cli.js',
  );
  if (existsSync(candidate)) {
    return candidate;
  }

  throw new Error('Could not locate the npm CLI entry point for launch testing.');
}

function runNpm(args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return runCaptured({
    command: process.execPath,
    args: [npmCliPath(), ...args],
    env,
    timeoutMs: NPM_TIMEOUT_MS,
    label: 'npm launch',
  });
}


class FakeInput extends PassThrough {
  isTTY = true;
  rawModes: boolean[] = [];

  setRawMode(mode: boolean): this {
    this.rawModes.push(mode);
    return this;
  }
}

class FakeOutput extends PassThrough {
  isTTY = true;
  columns = 80;
  rows = 24;
}

class FakeErrorOutput extends PassThrough {
  isTTY = true;
}

function capture(stream: PassThrough): { text: () => string } {
  let written = '';
  stream.on('data', (chunk: string | Buffer) => {
    written += chunk.toString();
  });
  return { text: () => written };
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 5_000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for ${message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForKeypressListener(input: FakeInput): Promise<void> {
  await waitFor(
    () => input.listenerCount('keypress') > 0,
    'terminal keypress listener',
  );
}

test('--help succeeds without a TTY and prints usage', async () => {
  const result = await runCli(['--help']);

  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.match(result.stdout, /Usage: pascal-desk/);
  assert.match(result.stdout, /--help/);
  assert.match(result.stdout, /file\.pas/);
  assert.equal(result.stdout.includes('\u001b[?1049h'), false);
});

test('-h is accepted as help', async () => {
  const result = await runCli(['-h']);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage: pascal-desk/);
});

test('unknown flags fail with usage on stderr', async () => {
  const result = await runCli(['--wat']);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /unknown flag/);
  assert.match(result.stderr, /Usage: pascal-desk/);
  assert.equal(result.stdout, '');
});

test('multiple file paths are rejected with usage', async () => {
  const result = await runCli(['one.pas', 'two.pas']);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /at most one file path/);
  assert.match(result.stderr, /Usage: pascal-desk/);
  assert.equal(result.stdout, '');
});

test('a missing startup file fails before the alternate screen without a TTY', async () => {
  const directory = temporaryDirectory('test-cli-');
  try {
    const missing = join(directory, 'missing.pas');
    const result = await runCli([missing]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /File not found/);
    assert.equal(result.stdout, '');
    assert.equal(result.stdout.includes('\u001b[?1049h'), false);
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('a valid startup file still requires a TTY', async () => {
  const directory = temporaryDirectory('test-cli-');
  try {
    const path = join(directory, 'valid.pas');
    writeFileSync(path, 'program Valid;\n');
    const result = await runCli([path]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /TTY/);
    assert.equal(result.stdout, '');
    assert.equal(result.stdout.includes('\u001b[?1049h'), false);
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('npm start forwards a real spaced file path to the CLI', async () => {
  const directory = temporaryDirectory('test-launch-');
  try {
    const scripts = (
      JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>;
      }
    ).scripts;
    assert.equal(scripts?.prestart, 'npm run build');
    assert.equal(scripts?.start, 'node dist/src/cli.js');
    assert.equal(scripts?.predemo, 'npm run build');
    assert.equal(scripts?.demo, 'node dist/src/cli.js examples/hello.pas');

    const file = join(directory, 'edited with spaces.pas');
    writeFileSync(file, 'program Spaced;\n');
    const argvFile = join(directory, 'received-argv.json');
    const hookPath = join(directory, 'argv-hook.cjs');
    writeFileSync(
      hookPath,
      `const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const entry = process.argv[1] ?? '';
if (entry.endsWith(join('dist', 'src', 'cli.js'))) {
  writeFileSync(
    process.env.PASCAL_DESK_ARGV_FILE,
    JSON.stringify(process.argv.slice(2)),
    'utf8',
  );
}
`,
    );

    const env: NodeJS.ProcessEnv = { ...process.env };
    const existingOptions = env.NODE_OPTIONS;
    const hookOptionPath = hookPath.replace(/\\/g, '/');
    env.NODE_OPTIONS = `${existingOptions === undefined || existingOptions === '' ? '' : `${existingOptions} `}--require "${hookOptionPath}"`;
    env.PASCAL_DESK_ARGV_FILE = argvFile;

    // Skip the prestart build here (asserted above) so this test cannot rewrite
    // dist/ while other test workers are loading modules.
    const result = await runNpm(
      ['start', '--ignore-scripts', '--', file],
      env,
    );

    assert.equal(result.code, 1);
    assert.equal(result.signal, null);
    assert.match(result.stderr, /requires a TTY/);
    assert.doesNotMatch(result.stderr, /File not found|ENOENT/);
    assert.equal(result.stdout.includes('\u001b[?1049h'), false);
    assert.deepEqual(
      JSON.parse(readFileSync(argvFile, 'utf8')),
      [file],
      'the CLI must receive the spaced path as one argument',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('main loads a startup file into the terminal before accepting input', async () => {
  const directory = temporaryDirectory('test-cli-');
  const input = new FakeInput();
  const output = new FakeOutput();
  const errors = new FakeErrorOutput();
  const written = capture(output);
  const errorText = capture(errors);

  try {
    const path = join(directory, 'startup file.pas');
    writeFileSync(path, 'program Startup;\n');

    const done = main([path], {
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
      error: errors as unknown as NodeJS.WriteStream,
    });

    await waitForKeypressListener(input);
    assert.match(written.text(), /startup file\.pas/);
    assert.equal(errorText.text(), '');

    input.emit('keypress', '\u0011', {
      name: 'q',
      sequence: '\u0011',
      ctrl: true,
    });
    const code = await done;

    assert.equal(code, 0);
    assert.ok(written.text().includes('\u001b[?1049h'));
    assert.ok(written.text().includes('\u001b[?1049l'));
  } finally {
    input.destroy();
    output.destroy();
    errors.destroy();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('main reports a startup file failure without entering the alternate screen', async () => {
  const directory = temporaryDirectory('test-cli-');
  const input = new FakeInput();
  const output = new FakeOutput();
  const errors = new FakeErrorOutput();
  const written = capture(output);
  const errorText = capture(errors);

  try {
    const missing = join(directory, 'missing.pas');
    const code = await main([missing], {
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
      error: errors as unknown as NodeJS.WriteStream,
    });

    assert.equal(code, 1);
    assert.match(errorText.text(), /File not found/);
    assert.equal(written.text().includes('\u001b[?1049h'), false);
    assert.equal(input.listenerCount('keypress'), 0);
    assert.equal(input.rawModes.length, 0);
  } finally {
    input.destroy();
    output.destroy();
    errors.destroy();
  }
});

test('runTerminal restores raw mode and the alternate screen exactly once', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const written = capture(output);

  try {
    const done = runTerminal(
      input as unknown as NodeJS.ReadStream,
      output as unknown as NodeJS.WriteStream,
    );

    input.emit('keypress', '\u0011', {
      name: 'q',
      sequence: '\u0011',
      ctrl: true,
    });
    input.emit('keypress', '\u0011', {
      name: 'q',
      sequence: '\u0011',
      ctrl: true,
    });

    const code = await done;
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(code, 0);
    assert.deepEqual(input.rawModes, [true, false]);
    assert.ok(written.text().includes('\u001b[?1049h'));
    assert.ok(written.text().includes('\u001b[?1049l'));
    assert.ok(written.text().includes('\u001b[?25h'));
    assert.equal(input.listenerCount('keypress'), 0);
  } finally {
    input.destroy();
    output.destroy();
  }
});

test('dirty quit confirmation keeps the editor until Y and then exits', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const written = capture(output);
  let editor = createEditor('draft', 'C:/draft.pas');
  editor = reduceEditor(editor, { type: 'insert', text: 'x' });

  try {
    const done = runTerminal(
      input as unknown as NodeJS.ReadStream,
      output as unknown as NodeJS.WriteStream,
      editor,
    );

    input.emit('keypress', '\u0011', {
      name: 'q',
      sequence: '\u0011',
      ctrl: true,
    });
    await waitFor(
      () => written.text().includes('Discard unsaved changes? Y / N'),
      'dirty discard confirmation',
    );

    input.emit('keypress', 'n', { name: 'n', sequence: 'n' });
    input.emit('keypress', '\u0011', {
      name: 'q',
      sequence: '\u0011',
      ctrl: true,
    });
    input.emit('keypress', 'y', { name: 'y', sequence: 'y' });
    const code = await done;

    assert.equal(code, 0);
    assert.ok(written.text().includes('\u001b[?1049l'));
  } finally {
    input.destroy();
    output.destroy();
  }
});

test('save errors stay inside the application and allow a clean quit', async () => {
  const directory = temporaryDirectory('test-cli-');
  const input = new FakeInput();
  const output = new FakeOutput();
  const written = capture(output);
  const missingParent = join(directory, 'missing', 'draft.pas');
  let editor = createEditor('draft', missingParent);
  editor = reduceEditor(editor, { type: 'insert', text: 'x' });

  try {
    const done = runTerminal(
      input as unknown as NodeJS.ReadStream,
      output as unknown as NodeJS.WriteStream,
      editor,
    );

    input.emit('keypress', '', { name: 'f2', sequence: '\u0012' });

    await waitFor(
      () => written.text().includes('Save failed:'),
      'save failure status',
    );
    assert.ok(written.text().includes('\u001b[?1049h'));

    input.emit('keypress', '\u0011', {
      name: 'q',
      sequence: '\u0011',
      ctrl: true,
    });
    input.emit('keypress', 'y', { name: 'y', sequence: 'y' });
    const code = await done;

    assert.equal(code, 0);
    assert.ok(written.text().includes('\u001b[?1049l'));
  } finally {
    input.destroy();
    output.destroy();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('small terminals freeze editing but still allow quitting', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = 50;
  output.rows = 12;
  const written = capture(output);

  try {
    const done = runTerminal(
      input as unknown as NodeJS.ReadStream,
      output as unknown as NodeJS.WriteStream,
    );

    input.emit('keypress', 'x', { sequence: 'x' });
    input.emit('keypress', '\u0011', {
      name: 'q',
      sequence: '\u0011',
      ctrl: true,
    });
    const code = await done;

    assert.equal(code, 0);
    assert.ok(written.text().includes('Terminal too small'));
    assert.ok(written.text().includes('\u001b[?1049l'));
  } finally {
    input.destroy();
    output.destroy();
  }
});
