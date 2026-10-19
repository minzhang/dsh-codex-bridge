// File-backed child-process capture for environments where piped stdio is
// unreliable (including the DSH Windows ACL sandbox). The child's stdout and
// stderr are real file descriptors in a unique temporary directory; stdin is
// ignored. No shell is involved, and the temporary directory is always removed.

import { spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEMP_PREFIX = 'dsh-capture-';

export class CaptureProcessError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CaptureProcessError';
    this.code = options.code;
    this.signal = options.signal;
    this.stdout = options.stdout ?? '';
    this.stderr = options.stderr ?? '';
    this.timedOut = options.timedOut === true;
  }
}

export class CaptureTimeoutError extends CaptureProcessError {
  constructor(timeoutMs, options = {}) {
    super(`process did not exit within ${timeoutMs}ms`, { ...options, timedOut: true });
    this.name = 'CaptureTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

function validateOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('options must be an object');
  }
  if (options.cwd !== undefined && (typeof options.cwd !== 'string' || options.cwd.length === 0)) {
    throw new TypeError('options.cwd must be a non-empty string');
  }
  if (options.env !== undefined && (options.env === null || typeof options.env !== 'object' || Array.isArray(options.env))) {
    throw new TypeError('options.env must be an object');
  }
  if (
    options.timeoutMs !== undefined &&
    (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)
  ) {
    throw new TypeError('options.timeoutMs must be a positive integer');
  }
}

function readCaptured(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    return { error };
  }
}

function terminate(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      resolve({ exited: true, forced: false });
      return;
    }
    let settled = false;
    let forced = false;
    let error;
    let graceHandle;
    let forceHandle;
    const done = (exited) => {
      if (settled) return;
      settled = true;
      if (graceHandle !== undefined) clearTimeout(graceHandle);
      if (forceHandle !== undefined) clearTimeout(forceHandle);
      resolve({ exited, forced, ...(error === undefined ? {} : { error }) });
    };
    child.once('close', () => done(true));

    // On Windows taskkill /T /F attempts the whole tree. On POSIX the
    // SIGTERM/SIGKILL sequence targets the direct child only; descendants are
    // not guaranteed to be reaped.
    if (process.platform === 'win32' && child.pid) {
      forced = true;
      let killer;
      try {
        killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
          shell: false,
        });
      } catch (spawnError) {
        error = `taskkill could not be started: ${spawnError.message}`;
        try {
          child.kill();
        } catch (killError) {
          error = `${error}; child.kill also failed: ${killError.message}`;
        }
      }
      if (killer) {
        killer.once('error', (killerError) => {
          error = `taskkill failed: ${killerError.message}`;
          try {
            child.kill();
          } catch (killError) {
            error = `${error}; child.kill also failed: ${killError.message}`;
          }
        });
        killer.once('close', (code) => {
          if (settled) return;
          if (code !== 0) {
            error = `taskkill exited ${code}`;
            try {
              child.kill();
            } catch (killError) {
              error = `${error}; child.kill failed: ${killError.message}`;
            }
          } else {
            try {
              child.kill();
            } catch {
              // taskkill already terminated it; the close event settles.
            }
          }
        });
      }
    } else {
      try {
        child.kill('SIGTERM');
      } catch (termError) {
        error = `SIGTERM failed: ${termError.message}`;
      }
      forceHandle = setTimeout(() => {
        if (settled) return;
        forced = true;
        try {
          child.kill('SIGKILL');
        } catch (killError) {
          error = `${error === undefined ? '' : `${error}; `}SIGKILL failed: ${killError.message}`;
        }
      }, 1000);
    }

    // Bound the wait: if the process is unkillable, unref it so it cannot keep
    // the caller's event loop alive forever, and report that exit is unknown.
    graceHandle = setTimeout(() => {
      try {
        child.unref();
      } catch (unrefError) {
        error = `${error === undefined ? '' : `${error}; `}child.unref failed: ${unrefError.message}`;
      }
      done(false);
    }, 7000);
  });
}

/**
 * Spawn a real child process and capture stdout/stderr through files.
 *
 * @param {string} command Executable path/name. Never interpreted by a shell.
 * @param {string[]} [args] Argument vector.
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number}} [options]
 *   On timeout, Windows uses taskkill /T /F (child tree); other platforms send
 *   SIGTERM then SIGKILL to the direct child only.
 * @returns {Promise<{code: number|null, signal: NodeJS.Signals|null, stdout: string, stderr: string}>}
 */
export async function captureProcess(command, args = [], options = {}) {
  if (typeof command !== 'string' || command.length === 0) {
    throw new TypeError('command must be a non-empty string');
  }
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== 'string')) {
    throw new TypeError('args must be an array of strings');
  }
  validateOptions(options);

  const tempDir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  const stdoutPath = join(tempDir, 'stdout.txt');
  const stderrPath = join(tempDir, 'stderr.txt');

  let stdoutFd;
  let stderrFd;
  let child;
  try {
    stdoutFd = openSync(stdoutPath, 'w');
    stderrFd = openSync(stderrPath, 'w');
    child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env === undefined ? undefined : { ...options.env },
      stdio: ['ignore', stdoutFd, stderrFd],
      windowsHide: true,
      shell: false,
    });
  } catch (error) {
    for (const fd of [stdoutFd, stderrFd]) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch (closeError) {
          // Reported together with the primary failure below.
          error = new AggregateError([error, closeError], 'capture setup failed and an output descriptor could not be closed');
        }
      }
    }
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'capture setup failed and the temporary directory could not be removed');
    }
    throw error;
  }

  for (const fd of [stdoutFd, stderrFd]) {
    try {
      closeSync(fd);
    } catch (error) {
      try {
        child.kill('SIGTERM');
      } catch {
        // The original close failure is the actionable error.
      }
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'capture output descriptor close failed and cleanup also failed');
      }
      throw error;
    }
  }

  return await new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let spawnFailure = null;
    let exitCode = null;
    let exitSignal = null;
    let terminationRequested = false;
    let timeoutHandle;

    const finish = (primaryError) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);

      const stdoutResult = readCaptured(stdoutPath);
      const stderrResult = readCaptured(stderrPath);
      const stdout = typeof stdoutResult === 'string' ? stdoutResult : '';
      const stderr = typeof stderrResult === 'string' ? stderrResult : '';
      let readFailure = null;
      if (typeof stdoutResult !== 'string') readFailure = stdoutResult.error;
      if (typeof stderrResult !== 'string') readFailure = readFailure ?? stderrResult.error;

      let cleanupFailure = null;
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch (error) {
        cleanupFailure = error;
      }

      const failures = [primaryError, readFailure, cleanupFailure].filter(Boolean);
      if (failures.length > 0) {
        let error;
        if (failures.length === 1) {
          error = failures[0];
        } else {
          error = new AggregateError(failures, failures.map((entry) => entry.message).join('; '));
        }
        error.stdout = stdout;
        error.stderr = stderr;
        error.signal = exitSignal;
        if (primaryError instanceof CaptureProcessError) {
          error.code = error.code ?? primaryError.code;
          error.timedOut = primaryError.timedOut;
          error.termination = error.termination ?? primaryError.termination;
        }
        rejectPromise(error);
        return;
      }

      resolvePromise({
        code: exitCode,
        signal: exitSignal,
        stdout,
        stderr,
      });
    };

    child.once('error', (error) => {
      spawnFailure = error;
      const wrapped = new CaptureProcessError(`failed to spawn ${command}: ${error.message}`, {
        code: error.code,
        stdout: '',
        stderr: '',
        cause: error,
      });
      if (!terminationRequested) finish(wrapped);
    });

    child.once('close', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      if (terminationRequested || spawnFailure) return;
      finish(null);
    });

    if (options.timeoutMs !== undefined) {
      timeoutHandle = setTimeout(() => {
        if (settled || terminationRequested) return;
        terminationRequested = true;
        void terminate(child).then((termination) => {
          const timeoutError = new CaptureTimeoutError(options.timeoutMs, { signal: exitSignal });
          timeoutError.termination = termination;
          if (!termination.exited) {
            timeoutError.message += '; child did not confirm exit after forced termination';
          } else if (termination.error) {
            timeoutError.message += `; termination note: ${termination.error}`;
          }
          finish(timeoutError);
        });
      }, options.timeoutMs);
    }
  });
}
