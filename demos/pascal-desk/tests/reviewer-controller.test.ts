import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, handleKey, type AppState, type KeyInput } from '../src/app.js';
import { createEditor, serialize } from '../src/editor.js';
import { renderScreen } from '../src/render.js';

const press = (state: AppState, key: KeyInput) => handleKey(state, key).state;

test('reviewer: resubmitting the prefilled find query advances and wraps without editing', () => {
  let state = createApp(createEditor('one ONE one'));
  const original = state.editor;
  state = press(state, { name: 'f', ctrl: true });
  state = press(state, { sequence: 'one' });
  state = press(state, { name: 'return' });
  assert.equal(state.editor.cursor.col, 0);
  for (const col of [4, 8, 0]) {
    state = press(state, { name: 'f', ctrl: true });
    assert.equal(state.prompt?.value, 'one');
    state = press(state, { name: 'return' });
    assert.equal(state.editor.cursor.col, col, 'same-query submission must advance past the current match');
  }
  assert.equal(serialize(state.editor), serialize(original));
  assert.deepEqual(state.editor.undoStack, original.undoStack);
  assert.deepEqual(state.editor.redoStack, original.redoStack);
});

test('reviewer: pending discard takes precedence over resize details when only a few rows remain', () => {
  let state = press(createApp(), { sequence: 'unsaved' });
  state = press(state, { name: 'q', ctrl: true });
  for (const [columns, rows] of [[30, 3], [80, 1]]) {
    const frame = renderScreen(state, columns!, rows!);
    const plain = frame.output.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
    assert.match(plain, /discard|unsaved/i, `${columns}x${rows} must expose the question before accepting Y`);
    assert.ok(plain.split('\r\n').length <= rows!);
    for (const line of plain.split('\r\n')) assert.ok(line.length < columns!);
  }
});
