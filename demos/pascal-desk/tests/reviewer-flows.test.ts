import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { main, runTerminal } from '../src/cli.js';

class Input extends PassThrough {
  isTTY = true;
  isRaw = false;
  setRawMode(value: boolean): this { this.isRaw = value; return this; }
}
class Output extends EventEmitter {
  columns = 80;
  rows = 25;
  isTTY = true;
  chunks: string[] = [];
  write(value: string): boolean { this.chunks.push(value); return true; }
  latest(): string { return (this.chunks.at(-1) ?? '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ''); }
}
const tick = () => new Promise<void>(resolveTick => setTimeout(resolveTick, 10));
async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!predicate() && Date.now() < deadline) await tick();
  assert.ok(predicate(), description);
}

for (const argument of ['--bad\x1b]0;injected-title\x07', '.dsh-runs/missing\x1b[2J.pas']) {
  test(`reviewer: startup diagnostics render untrusted argument safely (${argument.startsWith('-') ? 'flag' : 'path'})`, async () => {
    const input = new Input();
    const output = new Output();
    const error = new Output();
    try {
      assert.equal(await main([argument], {
        input: input as unknown as NodeJS.ReadStream,
        output: output as unknown as NodeJS.WriteStream,
        error: error as unknown as NodeJS.WriteStream,
      }), 1);
      const diagnostic = error.chunks.join('');
      assert.ok(diagnostic.length > 0);
      assert.doesNotMatch(diagnostic, /[\x00-\x08\x0b-\x1f\x7f-\x9f]/, 'diagnostics must not emit terminal controls from a flag/path');
      assert.equal(input.isRaw, false);
      assert.equal(output.chunks.length, 0, 'startup failure must precede alternate screen entry');
    } finally {
      input.destroy();
    }
  });
}

test('reviewer: terminal dialogs preserve rejected actions, save real paths with spaces, and isolate find input', async () => {
  const root = resolve('.dsh-runs');
  await mkdir(root, { recursive: true });
  const folder = await mkdtemp(join(root, 'reviewer-phase3-ui-'));
  const file = join(folder, 'saved with spaces.pas');
  const other = join(folder, 'existing other.pas');
  await writeFile(other, 'leave this untouched');
  const input = new Input();
  const output = new Output();
  const listenersBefore = process.listenerCount('SIGINT');
  const done = runTerminal(input as unknown as NodeJS.ReadStream, output as unknown as NodeJS.WriteStream);
  let ended = false;
  void done.then(() => { ended = true; });
  const key = (name: string, sequence = '', ctrl = false) => input.emit('keypress', sequence, { name, sequence, ctrl });
  const text = (value: string) => input.emit('keypress', value, { sequence: value });
  const control = (letter: string) => key(letter, String.fromCharCode(letter.toUpperCase().charCodeAt(0) - 64), true);
  try {
    text('original');
    control('q');
    assert.match(output.latest(), /discard|unsaved/i);
    key('return', '\r');
    await tick();
    assert.equal(ended, false, 'Enter must not silently discard a dirty document');
    text('n');
    control('s');
    text(file);
    key('return', '\r');
    await waitFor(() => /  Saved /i.test(output.latest()), 'successful Save As should finish');
    assert.equal(await readFile(file, 'utf8'), 'original');

    // Find input changes cursor, not document text; repeated search wraps safely.
    control('f');
    text('original');
    key('return', '\r');
    key('f4');
    text('Z');
    control('s');
    await waitFor(() => /  Saved /i.test(output.latest()), 'normal save should finish');
    assert.equal(await readFile(file, 'utf8'), 'Zoriginal');

    // Save As to an existing file must wait for explicit overwrite approval.
    key('f10');
    key('down'); key('down'); key('down'); key('return', '\r');
    // Save As may prefill the current path. Backspace enough to clear that prompt.
    for (let index = 0; index < file.length + 10; index++) key('backspace', '\x7f');
    text(other); key('return', '\r');
    await waitFor(() => /overwrite|replace/i.test(output.latest()), 'existing path should require overwrite confirmation');
    key('escape', '\x1b');
    assert.equal(await readFile(other, 'utf8'), 'leave this untouched');
    text('X');
    control('s');
    await waitFor(() => /  Saved /i.test(output.latest()), 'cancelled Save As must retain the old save destination');
    const saved = await readFile(file, 'utf8');
    assert.equal(saved, 'ZXoriginal');
    assert.equal(await readFile(other, 'utf8'), 'leave this untouched');

    // A resized terminal still accepts quit confirmation, but ignores ordinary edits.
    output.columns = 30; output.rows = 8; output.emit('resize');
    text('MUST_NOT_INSERT');
    output.columns = 80; output.rows = 25; output.emit('resize');
    control('s');
    await waitFor(() => /  Saved /i.test(output.latest()), 'save after resize should finish');
    assert.equal(await readFile(file, 'utf8'), saved);
    text('dirty');
    output.columns = 30; output.rows = 8; output.emit('resize');
    control('q');
    assert.match(output.latest(), /discard|unsaved/i, 'small-terminal confirmation must remain visible');
    text('y');
    assert.equal(await done, 0);
    assert.equal(input.isRaw, false);
    assert.equal(process.listenerCount('SIGINT'), listenersBefore);
  } finally {
    input.emit('end');
    await done;
    input.destroy();
    assert.ok(folder.startsWith(root + '\\') || folder.startsWith(root + '/'));
    await rm(folder, { recursive: true, force: true });
  }
});
