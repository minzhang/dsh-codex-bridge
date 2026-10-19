// Compile-only public API check with TypeScript and @types/node supplied by the host project.
import {
  captureProcess,
  CaptureProcessError,
  CaptureTimeoutError,
  type CaptureResult,
} from '../../dsh-codex-bridge/node/capture-process.mjs';

const result: CaptureResult = await captureProcess(process.execPath, ['--version'], { timeoutMs: 1000 });
const output: string = result.stdout;
const failure = new CaptureProcessError('spawn failed', {
  code: 'ENOENT',
  signal: null,
  stdout: '',
  stderr: '',
  timedOut: false,
  cause: new Error('underlying error'),
});
const timeout = new CaptureTimeoutError(1000, { signal: 'SIGTERM' });
const duration: number = timeout.timeoutMs;
const signal: NodeJS.Signals | null | undefined = failure.signal;
void [output, duration, signal];
