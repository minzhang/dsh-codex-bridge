import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditor, reduceEditor, serialize, markSaved, isDirty, type EditorAction } from '../src/editor.js';

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeDeep(child);
  }
  return value;
}

test('reviewer: randomized edits agree with a flat-string oracle and preserve frozen input', () => {
  let state = createEditor();
  let seed = 314159;
  const random = (limit: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % limit;
  };
  const directions = ['left', 'right', 'up', 'down', 'home', 'end', 'pageUp', 'pageDown'] as const;
  for (let iteration = 0; iteration < 1200; iteration++) {
    const beforeText = state.lines.join('\n');
    const beforeCursor = { ...state.cursor };
    const offset = state.lines.slice(0, state.cursor.row).reduce((n, line) => n + line.length + 1, 0) + state.cursor.col;
    let expected = beforeText;
    let action: EditorAction;
    switch (random(6)) {
      case 0:
      case 1: {
        const text = ['x', 'ABC', '\n', '\r\nq', '\t', '', 'a\rb'][random(7)]!;
        expected = beforeText.slice(0, offset) + text.replace(/\r\n?/g, '\n').replace(/\t/g, '  ') + beforeText.slice(offset);
        action = { type: 'insert', text };
        break;
      }
      case 2:
        expected = offset ? beforeText.slice(0, offset - 1) + beforeText.slice(offset) : beforeText;
        action = { type: 'backspace' };
        break;
      case 3:
        expected = beforeText.slice(0, offset) + beforeText.slice(offset + 1);
        action = { type: 'delete' };
        break;
      default:
        action = { type: 'move', direction: directions[random(directions.length)]!, pageSize: 3 };
    }
    const previous = freezeDeep(state);
    state = reduceEditor(previous, action);
    assert.equal(state.lines.join('\n'), expected, `flat text at step ${iteration}`);
    assert.equal(serialize(previous), beforeText, 'previous content remains unchanged');
    assert.deepEqual(previous.cursor, beforeCursor);
    assert.ok(state.lines.length >= 1);
    assert.ok(state.lines.every(line => !/[\r\n]/.test(line)));
    assert.ok(Number.isInteger(state.cursor.row) && state.cursor.row >= 0 && state.cursor.row < state.lines.length);
    assert.ok(Number.isInteger(state.cursor.col) && state.cursor.col >= 0 && state.cursor.col <= state.lines[state.cursor.row]!.length);
    if (expected !== beforeText) {
      const undone = reduceEditor(state, { type: 'undo' });
      assert.equal(serialize(undone), beforeText);
      assert.deepEqual(undone.cursor, beforeCursor);
      assert.equal(serialize(reduceEditor(undone, { type: 'redo' })), expected);
    }
  }
});

test('reviewer: save baseline and path survive undo/redo and empty edits retain redo', () => {
  let state = createEditor('a\r\nb\r\n', 'old.pas');
  state = reduceEditor(state, { type: 'insert', text: 'x' });
  state = markSaved(state, 'new.pas');
  assert.equal(isDirty(state), false);
  state = reduceEditor(state, { type: 'undo' });
  assert.equal(state.filePath, 'new.pas');
  assert.equal(isDirty(state), true);
  state = reduceEditor(state, { type: 'insert', text: '' });
  state = reduceEditor(state, { type: 'redo' });
  assert.equal(serialize(state), 'xa\r\nb\r\n');
  assert.equal(state.filePath, 'new.pas');
  assert.equal(isDirty(state), false);
});
