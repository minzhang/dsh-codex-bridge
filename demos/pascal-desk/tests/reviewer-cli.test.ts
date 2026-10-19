import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { runTerminal } from '../src/cli.js';

class ReviewInput extends PassThrough {
  isTTY = true;
  isRaw = false;
  setRawMode(value: boolean): this { this.isRaw = value; return this; }
}
class ReviewOutput extends EventEmitter {
  columns = 80;
  rows = 25;
  isTTY = true;
  chunks: string[] = [];
  write(value: string): boolean { this.chunks.push(value); return true; }
}

for (const surface of ['input', 'output'] as const) {
  test(`reviewer: ${surface} stream failure restores terminal state`, async () => {
    const input = new ReviewInput();
    const output = new ReviewOutput();
    const signalsBefore = process.listenerCount('SIGINT');
    const completion = runTerminal(input as unknown as NodeJS.ReadStream, output as unknown as NodeJS.WriteStream);
    assert.equal(input.isRaw, true);
    let uncaught: unknown;
    try { (surface === 'input' ? input : output).emit('error', new Error('reviewer simulated terminal disconnect')); }
    catch (error) { uncaught = error; }
    // Always clean up the original implementation, even when its error handling is absent.
    input.emit('keypress', '\x11', { name: 'q', ctrl: true, sequence: '\x11' });
    const exitCode = await completion;
    input.destroy();
    assert.equal(uncaught, undefined, 'terminal errors must be handled instead of crashing with raw mode enabled');
    assert.equal(exitCode, 1);
    assert.equal(input.isRaw, false);
    assert.equal(process.listenerCount('SIGINT'), signalsBefore);
  });
}
