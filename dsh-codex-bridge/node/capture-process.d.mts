/**
 * File-backed child-process capture (ESM declaration for `capture-process.mjs`).
 *
 * @example
 * ```ts
 * import { captureProcess, CaptureTimeoutError } from './capture-process.mjs';
 *
 * try {
 *   const result = await captureProcess(
 *     process.execPath,
 *     ['-e', "console.log('hello'); process.exit(3);"],
 *     { timeoutMs: 10_000 },
 *   );
 *   result.code;    // 3
 *   result.stdout;  // "hello\n"
 * } catch (error) {
 *   if (error instanceof CaptureTimeoutError) {
 *     error.termination?.exited; // whether the child confirmed exit
 *   }
 * }
 * ```
 */

export interface CaptureOptions {
  /** Working directory for the child. Defaults to the caller's cwd. */
  cwd?: string;
  /** Full environment for the child. Defaults to the caller's environment. */
  env?: NodeJS.ProcessEnv;
  /**
   * Positive timeout in milliseconds. On expiry the child is terminated; Windows
   * uses taskkill /T /F (child tree), other platforms SIGTERM then SIGKILL (direct
   * child only).
   */
  timeoutMs?: number;
}

export interface CaptureResult {
  /** Exit code, or null when the child was terminated by a signal. */
  code: number | null;
  /** Termination signal, or null. */
  signal: NodeJS.Signals | null;
  /** Captured standard output as UTF-8. */
  stdout: string;
  /** Captured standard error as UTF-8. */
  stderr: string;
}

export interface CaptureTermination {
  /** True when the child's close event confirmed exit. */
  exited: boolean;
  /** True when a forced termination path was used. */
  forced: boolean;
  /** Termination attempt detail when a step failed or fell back. */
  error?: string;
}

export interface CaptureErrorOptions {
  code?: string;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  cause?: unknown;
}

export class CaptureProcessError extends Error {
  constructor(message: string, options?: CaptureErrorOptions);
  code?: string;
  signal: NodeJS.Signals | null | undefined;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  termination?: CaptureTermination;
}

export interface CaptureTimeoutOptions extends Omit<CaptureErrorOptions, 'timedOut'> {}

export class CaptureTimeoutError extends CaptureProcessError {
  constructor(timeoutMs: number, options?: CaptureTimeoutOptions);
  timeoutMs: number;
}

/**
 * Spawn a real child process with file-backed capture.
 *
 * @throws {CaptureProcessError} when the process cannot be spawned.
 * @throws {CaptureTimeoutError} when the timeout expires.
 * @throws {AggregateError} when cleanup (or a secondary capture operation) also fails.
 */
export function captureProcess(
  command: string,
  args?: string[],
  options?: CaptureOptions,
): Promise<CaptureResult>;
